/**
 * Every figure on the Gnosis registry census report (/field/gnosis-registry-2026-11-06), in one place. The page reads only this file,
 * and client/src/pages/gnosisRegistryReport.test.ts fails if a number on the page is not one of these, if one of these does not
 * appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/gnosis-census-2026-11-06.md and the queries are in docs/gnosis-census-queries-2026-11-06.sql.
 * Nothing was recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here
 * from MEASURED, so the page writes no figure of its own.
 *
 * Gnosis's data is small and lopsided (one host name, one wallet, two days, months with none), so every derived figure is defined
 * for a short or empty list: a least or a most of nothing reads as zero, and the test fails on any figure that is not a finite number.
 *
 * A share is given to one decimal place and rounded to the nearest.
 */
export const GNOSIS_DOC = "docs/gnosis-census-2026-11-06.md";
export const GNOSIS_SQL = "docs/gnosis-census-queries-2026-11-06.sql";

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/**
 * What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts),
 * the most registry rows one host may keep (`FLOOD_HOST_ROW_CAP`), and the blocks whose times were read from a node on 2026-11-06:
 * the registry's first block and the finalized block that the last stretch runs to.
 *
 * Gnosis's block time is close to constant, about 5.1 to 5.2 seconds a block (`blockSecondsLow` and `blockSecondsHigh` are the lowest and
 * the highest rate of the stretches, to one decimal place), with a slot missed now and then. So there is no second rate for the days:
 * the queries date a day and a month through the same `stretches` stretches of `stretchBlocks` blocks, from the first block to the
 * finalized block (the last stretch is the shorter), each with a start block, its time and its seconds a block read from the chain.
 * `dateErrorMinutes` is how far a date was from the real block time at the worst of the `dateChecked` registrations whose logs carry
 * a block time, and `dateMedianErrorMinutes` the median. `dayWindow` is how many days query 10a looks back from the newest
 * registration's day.
 */
export const CHAIN = {
  id: 100,
  handoutBlocks: 708,
  hostRowCap: 2_000,
  firstBlock: 44_505_010,
  firstBlockTime: "2026-02-04 09:49:00",
  recentBlock: 49_146_890,
  recentBlockTime: "2026-11-06 23:11:40",
  stretches: 19,
  stretchBlocks: 250_000,
  blockSecondsLow: 5.1,
  blockSecondsHigh: 5.2,
  dayWindow: 21,
  dateChecked: 4_179,
  dateErrorMinutes: 148,
  dateMedianErrorMinutes: 1.6,
} as const;

/**
 * Figures that are not from the queries, read from GET /api/v1/stats on 2026-11-06 at 23:17 UTC: the public count of listed entries,
 * and the public count of registrations on the chain. No registration is hidden, so the first is the same as query 0's entries, and
 * the second is the registrations stored plus the registrations counted past a host's cap.
 */
export const PUBLIC = { listed: 41, onChain: 4_179 } as const;

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
/** Query 4: the ten largest host names by size and never by name. Fewer come back when fewer host names exist. */
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
/** Query 10b: registrations in each UTC month that has one. */
type Q10bRow = readonly [utcMonth: string, registrations: number];

export const MEASURED = {
  date: "2026-11-06",
  q0: [[2328, 0, "2026-11-06 21:11:32", "2026-11-06 21:12:30", "2026-11-06 21:12:38", 41]] satisfies Q0Row[],
  q0b: [[1, 1851, 1851]] satisfies Q0bRow[],
  q1: [[2328, 52, 0, 2051, 8, 2295, 8, 2328]] satisfies Q1Row[],
  q2: [
    ["1", 21, 21, 1],
    ["2-9", 5, 22, 8],
    ["10-49", 25, 285, 34],
    ["1000+", 1, 2000, 2000],
  ] satisfies Q2Row[],
  q3: [[1, 2000, 2000, 2000, 1, 2000]] satisfies Q3Row[],
  q3b: [[1, 2000, 2000]] satisfies Q3bRow[],
  q4: [
    [1, 2000],
    [2, 33],
    [3, 11],
    [4, 3],
    [5, 1],
    [6, 1],
    [7, 1],
    [8, 1],
  ] satisfies Q4Row[],
  q4b: [[1, 2000, 2000]] satisfies Q4bRow[],
  q5: [
    ["1", 2284, 2284, 1, 2015],
    ["2-9", 9, 25, 5, 25],
    ["10-49", 1, 11, 11, 11],
  ] satisfies Q5Row[],
  q6: [[2328, 2064, 244, 40, 0, 2]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 9],
    [1, "listed", "-", 41],
    [2, "held out as shared", "host shared by 50 or more", 2000],
    [2, "held out as shared", "profile link shared by 2 or more", 36],
    [2, "held out as shared", "wallet that registered 10 or more", 241],
    [4, "name is only a number", "-", 1],
  ] satisfies Q7Row[],
  q8: [[2328, 2328, 2328, 5, 4, 5, 4, 49, 24]] satisfies Q8Row[],
  q9: [
    ["mint", 2328, 2328, 44506402, 48805644],
    ["secondary", 5, 5, 45119618, 45211076],
    ["uri_update", 49, 24, 44720956, 47894843],
  ] satisfies Q9Row[],
  q10a: [
    ["2026-10-09", 1],
    ["2026-10-17", 1],
  ] satisfies Q10aRow[],
  q10b: [
    ["2026-02", 2015],
    ["2026-03", 273],
    ["2026-04", 23],
    ["2026-06", 14],
    ["2026-08", 1],
    ["2026-10", 2],
  ] satisfies Q10bRow[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
/** The least and the most of a list. A list with nothing in it has neither, and reads as zero, so that no figure is Infinity or NaN. */
const least = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.min(...values));
const most = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.max(...values));

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
/** The largest wallet outside the largest bucket. The largest bucket holds one wallet, so this is the next largest wallet of all. */
const nextLargestWallet = most(MEASURED.q2.filter(row => row[0] !== topWalletBucket[0]).map(row => row[3]));
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
/** The links used by 50 or more registrations: neither of these buckets came back, so both read as zero. */
const bigLinks = [linkBucket("50-999"), linkBucket("1000+")];
const links = sum(MEASURED.q5.map(row => row[1]));

const days = MEASURED.q10a;
const months = MEASURED.q10b;
const firstMonth = months[0] ?? ["", 0];
const laterMonths = months.slice(1);
const passDay = q0[4].slice(0, 10);
const passMonth = passDay.slice(0, 7);
const firstDay = days[0]?.[0] ?? "";
const lastDay = days[days.length - 1]?.[0] ?? "";
/** A month written YYYY-MM as a count of months, and back, so that the months between two of them can be listed. */
const monthNumber = (label: string): number => Number(label.slice(0, 4)) * 12 + Number(label.slice(5, 7)) - 1;
const monthLabel = (index: number): string => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
/** The months after the first and before the month of the pass: whole months, with a registration stored in them or not. */
const wholeLaterMonths = Array.from({ length: Math.max(0, monthNumber(passMonth) - monthNumber(firstMonth[0]) - 1) }, (_, index) => monthLabel(monthNumber(firstMonth[0]) + 1 + index));
/** The whole months after the first in which no registration is stored: the query returns no row for a month with none. */
const monthsWithNone = wholeLaterMonths.filter(label => !months.some(row => row[0] === label));
/** Whole days from one UTC date to another, both written YYYY-MM-DD. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

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
    /** The wallets that registered 50 or more, and what they made. The page words it in the singular: a test holds that it is one. */
    large: largeWalletCount,
    largeRegistrations: largeWalletRegistrations,
    largePercent: percent(largeWalletRegistrations, registrations),
    tenOrMore: tenOrMoreWallets,
    tenOrMoreRegistrations,
    tenOrMorePercent: percent(tenOrMoreRegistrations, registrations),
    /** The largest bucket query 2 returned: its label and its wallets (the page words it as one wallet; a test holds that it is one). */
    topBucket: topWalletBucket[0],
    topBucketWallets: topWalletBucket[1],
    /** The most any wallet made outside the largest bucket. */
    nextLargest: nextLargestWallet,
  },
  /** The wallets of query 3, and how their registrations are spread across host names and profile links. */
  largeWallets: {
    shown: wallets.length,
    registrations: sum(wallets.map(row => row[1])),
    onOneHost: onOneHost.length,
    withoutAHost: withoutAHost.length,
    ownLinkEach: ownLinkEach.length,
    oneLinkForAll: oneLinkForAll.length,
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
    /** The links used by 50 or more registrations, and the registrations on them: none came back, and the page says so. */
    big: sum(bigLinks.map(row => row[1])),
    bigRegistrations: sum(bigLinks.map(row => row[2])),
    /** The most registrations any one link has. */
    largest: most(MEASURED.q5.map(row => row[3])),
    largestPercent: percent(most(MEASURED.q5.map(row => row[3])), registrations),
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
    /** Transfers that were not a hand-out: they came later than the first hour, or from a wallet other than the one the registration was minted to. The page words it as one transfer. */
    laterTransfers: q8[3] - q8[4],
    edits: q8[7],
    edited: q8[8],
    editedPercent: percent(q8[8], registrations),
  },
  /** When the registrations were made, in UTC months and days worked out from the mint block's time. */
  time: {
    /** The months the query returned: the ones that have a registration. */
    months: months.length,
    firstMonth: firstMonth[0],
    firstMonthRegistrations: firstMonth[1],
    firstMonthPercent: percent(firstMonth[1], registrations),
    /** The whole months between the first month and the month of the pass, with a registration stored in them or not. */
    wholeLaterMonths: wholeLaterMonths.length,
    /** Of those, the months that have a registration, the registrations in them, and the least and the most in one of them. */
    laterMonths: laterMonths.length,
    laterMonthsRegistrations: sum(laterMonths.map(row => row[1])),
    laterMonthsPercent: percent(sum(laterMonths.map(row => row[1])), registrations),
    laterLow: least(laterMonths.map(row => row[1])),
    laterHigh: most(laterMonths.map(row => row[1])),
    /** And the months that have none. */
    monthsWithNone,
    monthsWithNoneCount: monthsWithNone.length,
    /** The month of the pass the census is counted from, and the registrations stored in it so far. */
    passMonth,
    passMonthRegistrations: months.find(row => row[0] === passMonth)?.[1] ?? 0,
    /** The days of the window that have a registration, and the days of it that have none. */
    days: days.length,
    daysWithNone: CHAIN.dayWindow - days.length,
    firstDay,
    /** The last day the query returned is the day of the newest stored registration, which is where the window ends. */
    lastDay,
    daysRegistrations: sum(days.map(row => row[1])),
    daysPercent: percent(sum(days.map(row => row[1])), registrations),
    /** The least and the most registrations in one day that has any. The page words it as one each: a test holds that. */
    dayLeast: least(days.map(row => row[1])),
    dayMost: most(days.map(row => row[1])),
    /** The UTC day of the pass the census is counted from, and how many days after the newest stored registration it fell. */
    passDay,
    daysBeforeThePass: daysBetween(lastDay, passDay),
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[4].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
