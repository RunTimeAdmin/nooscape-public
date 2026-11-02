/**
 * Every figure on the Monad registry census report (/field/monad-registry-2026-11-01), in one place. The page reads only this file,
 * and client/src/pages/monadRegistryReport.test.ts fails if a number on the page is not one of these, if one of these does not
 * appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/monad-census-2026-11-01.md and the queries are in docs/monad-census-queries-2026-11-01.sql.
 * Nothing was recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here
 * from MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest.
 */
export const MONAD_DOC = "docs/monad-census-2026-11-01.md";
export const MONAD_SQL = "docs/monad-census-queries-2026-11-01.sql";

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/**
 * What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts),
 * the most registry rows one host may keep (`FLOOD_HOST_ROW_CAP`), and the blocks whose times were read from a public node on
 * 2026-11-01: the registry's first block and the finalized block the day queries count back from.
 *
 * Monad's block time was not constant: about 0.4 seconds a block from the first block to `fastEndsAtBlock`, and about 0.3 seconds
 * since. So the month query follows `stretches` runs of blocks, each with a start block, its time and its seconds a block read from
 * the chain, and the day query counts back from the finalized block at the average of the last 200,000 blocks. `dayErrorMinutes`
 * and `monthErrorMinutes` say how far a date can be off in each case (the month figure is the worst of 400 random blocks, and
 * `monthMedianErrorMinutes` is the median of the same 400). `dayWindow` is how many days query 10a looks back from the newest
 * registration's day.
 */
export const CHAIN = {
  id: 143,
  handoutBlocks: 11_918,
  hostRowCap: 2_000,
  firstBlock: 52_952_790,
  firstBlockTime: "2026-02-03 11:36:02",
  recentBlock: 118_545_151,
  recentBlockTime: "2026-11-01 18:47:03",
  earlyBlockSeconds: 0.4,
  laterBlockSeconds: 0.3,
  fastEndsAtBlock: 89_652_790,
  rateBlocks: 200_000,
  stretches: 29,
  dayWindow: 21,
  dayErrorMinutes: 30,
  monthErrorMinutes: 40,
  monthMedianErrorMinutes: 2.5,
} as const;

/** The seconds a block is taken to last in the day formula of the queries, as the file writes it: the average over the last 200,000 blocks, counted back from the finalized block. */
export const DATING = { daySeconds: "0.30268" } as const;

/**
 * Figures that are not from the queries, read from GET /api/v1/stats on 2026-11-01 at 19:21 UTC: the public count of listed entries,
 * and the public count of registrations on the chain. No registration is hidden, so the first is the same as query 0's entries, and
 * the second is the registrations stored plus the registrations counted past a host's cap.
 */
export const PUBLIC = { listed: 144, onChain: 10_421 } as const;

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
/** Query 3: the 25 largest wallets that made the large-wallet threshold or more, by size and never by address. Fewer come back when fewer wallets reach it. */
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
/** Query 10a: registrations in each UTC day, among the days of the window, that has one. */
type Q10aRow = readonly [utcDay: string, registrations: number];
/** Query 10b: registrations in each UTC month. */
type Q10bRow = readonly [utcMonth: string, registrations: number];

export const MEASURED = {
  date: "2026-11-01",
  q0: [[4327, 0, "2026-11-01 03:24:06", "2026-11-01 17:15:08", "2026-11-01 17:15:08", 144]] satisfies Q0Row[],
  q0b: [[1, 6094, 6094]] satisfies Q0bRow[],
  q1: [[4327, 2592, 0, 4037, 43, 2149, 67, 4327]] satisfies Q1Row[],
  q2: [
    ["1", 2400, 2400, 1],
    ["2-9", 184, 442, 8],
    ["10-49", 4, 81, 45],
    ["50-99", 2, 128, 75],
    ["100-999", 2, 1276, 762],
  ] satisfies Q2Row[],
  q3: [
    [1, 762, 762, 762, 1, 762],
    [2, 514, 514, 514, 1, 514],
    [3, 75, 0, 0, 0, 75],
    [4, 53, 53, 51, 3, 29],
  ] satisfies Q3Row[],
  q3b: [[4, 1404, 762]] satisfies Q3bRow[],
  q4: [
    [1, 2000],
    [2, 762],
    [3, 528],
    [4, 483],
    [5, 51],
    [6, 39],
    [7, 36],
    [8, 34],
    [9, 14],
    [10, 11],
  ] satisfies Q4Row[],
  q4b: [[5, 3824, 2000]] satisfies Q4bRow[],
  q5: [
    ["1", 2117, 2117, 1, 1915],
    ["2-9", 27, 80, 8, 59],
    ["10-49", 3, 64, 29, 64],
    ["1000+", 1, 1999, 1999, 1999],
  ] satisfies Q5Row[],
  q6: [[4327, 4239, 77, 15, 0, 9]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 169],
    [1, "listed", "-", 144],
    [2, "held out as shared", "host shared by 50 or more", 1796],
    [2, "held out as shared", "profile link shared by 2 or more", 2135],
    [2, "held out as shared", "wallet that registered 10 or more", 83],
  ] satisfies Q7Row[],
  q8: [[4327, 4327, 4327, 87, 75, 86, 75, 121, 64]] satisfies Q8Row[],
  q9: [
    ["mint", 4327, 4327, 53006722, 118390856],
    ["secondary", 87, 86, 54167560, 118390878],
    ["uri_update", 121, 64, 53698090, 117855509],
  ] satisfies Q9Row[],
  q10a: [
    ["2026-10-12", 10],
    ["2026-10-13", 23],
    ["2026-10-14", 2],
    ["2026-10-15", 1],
    ["2026-10-19", 3],
    ["2026-10-20", 1],
    ["2026-10-23", 1],
    ["2026-10-25", 1],
    ["2026-10-28", 1],
    ["2026-11-01", 1],
  ] satisfies Q10aRow[],
  q10b: [
    ["2026-02", 2265],
    ["2026-03", 11],
    ["2026-04", 6],
    ["2026-05", 19],
    ["2026-06", 542],
    ["2026-07", 1250],
    ["2026-08", 46],
    ["2026-09", 42],
    ["2026-10", 145],
    ["2026-11", 1],
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
/** The largest bucket of query 2 that has a wallet in it: the last row the query returned. */
const topWalletBucket: Q2Row = MEASURED.q2[MEASURED.q2.length - 1] ?? ["", 0, 0, 0];
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
/** The largest link outside the largest bucket, which holds one link: the next largest link of all. */
const nextLargestLink = Math.max(...MEASURED.q5.filter(row => row[0] !== "1000+").map(row => row[3]));

const days = MEASURED.q10a;
const months = MEASURED.q10b;
const firstMonth = months[0] ?? ["", 0];
const lastMonth = months[months.length - 1] ?? ["", 0];
const laterMonths = months.slice(1);
/** The months between the first and the last: whole months. The last is the month of the pass and is partial. */
const wholeLaterMonths = months.slice(1, -1);
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
    byLinkPercent: percent(firstRule(RULES.link), registrations),
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
    /** The largest bucket query 2 returned: its label, its wallets and the registrations they made. */
    topBucket: topWalletBucket[0],
    topBucketWallets: topWalletBucket[1],
    topBucketRegistrations: topWalletBucket[2],
    topBucketPercent: percent(topWalletBucket[2], registrations),
    largest: q3b[2],
    largestPercent: percent(q3b[2], registrations),
  },
  /** The wallets of query 3, and how their registrations are spread across host names and profile links. */
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
    /** What the host past the cap holds in all: the rows kept and the registrations counted, and that as a share of the registrations on the chain. */
    largestHeld: host(1) + q0b[2],
    largestHeldPercent: percent(host(1) + q0b[2], REGISTRY.onChain),
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
    nextLargest: nextLargestLink,
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
    laterHigh: Math.max(...laterMonths.map(row => row[1])),
    /** The whole months between the first month and the month of the pass, with the least and most registrations in one of them. */
    wholeLaterMonths: wholeLaterMonths.length,
    wholeLaterRegistrations: sum(wholeLaterMonths.map(row => row[1])),
    wholeLaterPercent: percent(sum(wholeLaterMonths.map(row => row[1])), registrations),
    wholeLaterLow: Math.min(...wholeLaterMonths.map(row => row[1])),
    wholeLaterHigh: Math.max(...wholeLaterMonths.map(row => row[1])),
    /** The month of the pass, which has had only part of its days. */
    lastMonth: lastMonth[0],
    lastMonthRegistrations: lastMonth[1],
    days: days.length,
    /** The days of the window that no registration was made on. */
    daysWithNone: CHAIN.dayWindow - days.length,
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
    /** The UTC day of the pass the census is counted from. The newest registration is dated that day. */
    passDay: q0[4].slice(0, 10),
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[4].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
