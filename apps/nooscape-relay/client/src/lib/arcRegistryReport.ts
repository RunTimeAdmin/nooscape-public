/**
 * Every figure on the Arc registry census report (/field/arc-registry-2026-10-20), in one place. The page reads only this file,
 * and client/src/pages/arcRegistryReport.test.ts fails if a number on the page is not one of these, if one of these does not
 * appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/arc-census-2026-10-20.md and the queries are in docs/arc-census-queries-2026-10-20.sql. Nothing was
 * recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here from
 * MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest, so it can sit beside the Arc page's share of the same
 * registrations, which that page rounds down to a whole number.
 */
export const ARC_DOC = "docs/arc-census-2026-10-20.md";
export const ARC_SQL = "docs/arc-census-queries-2026-10-20.sql";

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/** What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts), and a chain-day in blocks (about a day at Arc's block time). */
export const CHAIN = { id: 5042, handoutBlocks: 7_080, dayBlocks: 169_920 } as const;

/** The first rule that reaches a registration the listing rules hold out, as query 7 words it. The rules run in this order. */
export const RULES = { link: "profile link shared by 2 or more", host: "host shared by 50 or more", wallet: "wallet that registered 10 or more" } as const;

/** Query 0: the registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many the directory lists. */
export type Q0Row = readonly [registrations: number, hidden: number, firstSeen: string, lastSeen: string, lastSuccess: string, inDirectory: number];
/** Query 1: size and surface. */
export type Q1Row = readonly [registrations: number, wallets: number, noWallet: number, withHttpsHost: number, hosts: number, distinctProfileLinks: number, noUriSet: number, mintMeasured: number];
/** Query 2: a size bucket of registrations made by one wallet, how many wallets fall in it, the registrations they made, and the largest in it. */
export type Q2Row = readonly [bucket: string, wallets: number, registrations: number, largest: number];
/** Query 3: the wallets that made the large-wallet threshold or more, by size and never by address. */
export type Q3Row = readonly [walletRank: number, registrations: number, withHttpsHost: number, onItsLargestHost: number, hosts: number, links: number];
/** Query 4: the host names by size and never by name. Rank 0 is how many host names hold the large-host threshold or more registrations. */
export type Q4Row = readonly [hostRank: number, registrations: number];
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
/** Query 10: registrations in each chain-day since the first mint block measured. */
export type Q10Row = readonly [day: number, registrations: number];

export const MEASURED = {
  date: "2026-10-20",
  q0: [[2587, 0, "2026-10-20 16:42:50", "2026-10-20 16:43:56", "2026-10-20 16:45:40", 246]] satisfies Q0Row[],
  q1: [[2587, 257, 0, 1139, 44, 2305, 18, 2587]] satisfies Q1Row[],
  q2: [
    ["1", 225, 225, 1],
    ["2-9", 24, 72, 6],
    ["10-49", 1, 22, 22],
    ["50-99", 4, 300, 98],
    ["100-999", 2, 968, 868],
    ["1000+", 1, 1000, 1000],
  ] satisfies Q2Row[],
  q3: [
    [1, 1000, 0, 0, 0, 1000],
    [2, 868, 868, 868, 1, 868],
    [3, 100, 100, 100, 1, 100],
    [4, 98, 0, 0, 0, 1],
    [5, 91, 0, 0, 0, 1],
    [6, 56, 56, 56, 1, 56],
    [7, 55, 0, 0, 0, 1],
  ] satisfies Q3Row[],
  q4: [
    [0, 3],
    [1, 868],
    [2, 115],
    [3, 56],
    [4, 23],
    [5, 14],
  ] satisfies Q4Row[],
  q5: [
    ["1", 2296, 2296, 1, 1115],
    ["2-9", 6, 12, 2, 8],
    ["10-49", 1, 16, 16, 16],
    ["50+", 1, 245, 245, 0],
  ] satisfies Q5Row[],
  q6: [[2587, 1536, 1049, 4, 0, 2]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 23],
    [1, "listed", "-", 246],
    [2, "held out as shared", "host shared by 50 or more", 1023],
    [2, "held out as shared", "profile link shared by 2 or more", 273],
    [2, "held out as shared", "wallet that registered 10 or more", 1022],
  ] satisfies Q7Row[],
  q8: [[2587, 2587, 2587, 897, 897, 897, 897, 148, 141]] satisfies Q8Row[],
  q9: [
    ["mint", 2587, 2587, 21156191, 26966416],
    ["secondary", 897, 897, 22313910, 26717515],
    ["uri_update", 148, 141, 21214757, 26786119],
  ] satisfies Q9Row[],
  q10: [
    [0, 131],
    [1, 11],
    [2, 10],
    [3, 7],
    [4, 8],
    [5, 5],
    [6, 14],
    [7, 13],
    [8, 23],
    [9, 69],
    [10, 11],
    [11, 22],
    [12, 12],
    [13, 14],
    [14, 1014],
    [15, 12],
    [16, 12],
    [17, 10],
    [18, 18],
    [19, 878],
    [20, 10],
    [21, 6],
    [22, 6],
    [23, 10],
    [24, 34],
    [25, 14],
    [26, 15],
    [27, 36],
    [28, 45],
    [29, 8],
    [30, 35],
    [31, 17],
    [32, 13],
    [33, 41],
    [34, 3],
  ] satisfies Q10Row[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const q0: Q0Row = MEASURED.q0[0];
const q1: Q1Row = MEASURED.q1[0];
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
const fifty = walletBucket("50-99");
const hundred = walletBucket("100-999");
const thousand = walletBucket("1000+");
const largeWalletCount = fifty[1] + hundred[1] + thousand[1];
const largeWalletRegistrations = fifty[2] + hundred[2] + thousand[2];
const tenOrMoreWallets = ten[1] + largeWalletCount;
const tenOrMoreRegistrations = ten[2] + largeWalletRegistrations;

const wallets: readonly Q3Row[] = MEASURED.q3;
const onOneHost = wallets.filter(row => row[4] === 1 && row[1] === row[2] && row[2] === row[3]);
const withoutAHost = wallets.filter(row => row[2] === 0);
const ownLinkEach = wallets.filter(row => row[5] === row[1]);
const oneLinkForAll = wallets.filter(row => row[5] === 1);
/** The wallet whose registrations are all on one host name that is the largest of all and larger than the next, if there is one. */
const walletIsLargestHost = wallets.find(row => row[4] === 1 && row[1] === row[2] && row[2] === row[3] && row[1] === host(1) && host(1) > host(2));

const sharedLinks = MEASURED.q5.filter(row => row[0] !== "1");
const bigLink = linkBucket("50+");
const links = sum(MEASURED.q5.map(row => row[1]));

const days = MEASURED.q10;
const busiestDays = [...days].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
/** The chain-days that had `low` to `high` registrations, as a label, how many days they are and the registrations in them. */
const dayBucket = (label: string, low: number, high: number): readonly [label: string, days: number, registrations: number] => {
  const rows = days.filter(row => row[1] >= low && row[1] <= high);
  return [label, rows.length, sum(rows.map(row => row[1]))];
};

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
    byWallet: firstRule(RULES.wallet),
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
    largest: Math.max(0, ...MEASURED.q2.map(row => row[3])),
    largestPercent: percent(Math.max(0, ...MEASURED.q2.map(row => row[3])), registrations),
  },
  /** The wallets that made the large-wallet threshold or more, and how their registrations are spread across host names and profile links. */
  largeWallets: {
    count: wallets.length,
    onOneHost: onOneHost.length,
    withoutAHost: withoutAHost.length,
    ownLinkEach: ownLinkEach.length,
    oneLinkForAll: oneLinkForAll.length,
    oneLinkRegistrations: sum(oneLinkForAll.map(row => row[1])),
    /** Set when one wallet's registrations are the whole of the largest host name. */
    walletIsLargestHost: walletIsLargestHost !== undefined,
    walletIsLargestHostRegistrations: walletIsLargestHost?.[1] ?? 0,
  },
  /** Host names, by size. */
  hosts: {
    withHttps: REGISTRY.withHttpsHost,
    withHttpsPercent: percent(REGISTRY.withHttpsHost, registrations),
    withoutHost: registrations - REGISTRY.withHttpsHost,
    withoutHostPercent: percent(registrations - REGISTRY.withHttpsHost, registrations),
    largest: host(1),
    largestPercent: percent(host(1), REGISTRY.withHttpsHost),
    second: host(2),
    third: host(3),
    twoLargest: host(1) + host(2),
    twoLargestPercent: percent(host(1) + host(2), REGISTRY.withHttpsHost),
    atLeastThreshold: host(0),
  },
  /** Profile links, by how many registrations use one. */
  links: {
    total: links,
    usedOnce: linkBucket("1")[1],
    usedOncePercent: percent(linkBucket("1")[1], links),
    shared: sum(sharedLinks.map(row => row[1])),
    sharedRegistrations: sum(sharedLinks.map(row => row[2])),
    big: bigLink[1],
    bigRegistrations: bigLink[2],
    bigPercent: percent(bigLink[2], registrations),
    bigWithHost: bigLink[4],
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
  /** When the registrations were made, in chain-days counted from the first. */
  days: {
    count: days.length,
    busiest: busiestDays[0]?.[1] ?? 0,
    second: busiestDays[1]?.[1] ?? 0,
    twoBusiest: (busiestDays[0]?.[1] ?? 0) + (busiestDays[1]?.[1] ?? 0),
    twoBusiestPercent: percent((busiestDays[0]?.[1] ?? 0) + (busiestDays[1]?.[1] ?? 0), registrations),
    /** The most registrations in any other chain-day. */
    otherBusiest: busiestDays[2]?.[1] ?? 0,
    buckets: [dayBucket("1000+", 1000, Number.MAX_SAFE_INTEGER), dayBucket("100-999", 100, 999), dayBucket("10-99", 10, 99), dayBucket("1-9", 1, 9)],
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[4].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
