/**
 * Every figure on the Arc registry census report of 6 November 2026 (/field/arc-registry-2026-11-06), in one place. The page reads
 * only this file, and client/src/pages/arcRegistryReport20261106.test.ts fails if a number on the page is not one of these, if one
 * of these does not appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/arc-census-2026-11-06.md and the queries are in docs/arc-census-queries-2026-11-06.sql. Nothing was
 * recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here from
 * MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest, so it can sit beside the Arc page's share of the same
 * registrations, which that page rounds down to a tenth of a percent.
 */
export const ARC_DOC = "docs/arc-census-2026-11-06.md";
export const ARC_SQL = "docs/arc-census-queries-2026-11-06.sql";

/** The census before this one. It stays at its own address, and its figures are not repeated here. */
export const PREVIOUS = { date: "2026-10-20", route: "/field/arc-registry-2026-10-20" } as const;

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/**
 * What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts),
 * a chain-day in blocks (about a day at Arc's block time), and the most registry rows one host may keep (`FLOOD_HOST_ROW_CAP`).
 */
export const CHAIN = { id: 5042, handoutBlocks: 7_080, dayBlocks: 169_920, hostRowCap: 2_000 } as const;

/**
 * Figures that are not from the queries, read from GET /api/v1/stats on 2026-11-06 at 10:01 UTC: the public count of listed entries,
 * and the public count of registrations on the chain. No registration is hidden, so the first is the same as query 0's entries, and
 * the second is the registrations stored plus the registrations counted past a host's cap. The same read gave 2026-11-06T09:06:33Z
 * as the last read of the chain, the time query 0 and query 11 give for the pass.
 */
export const PUBLIC = { listed: 480, onChain: 385_752 } as const;

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
type Q10Row = readonly [day: number, registrations: number];
/** Query 11: the host cap: the hosts past it, the registrations counted and not stored for them, and when the source last succeeded. */
export type Q11Row = readonly [hostsPastTheCap: number, countedNotStored: number, lastSuccess: string];
/** Query 12: the five largest hosts by what they hold in all, by rank and never by name: the rows stored, the registrations counted past the cap, and both together. */
export type Q12Row = readonly [hostRank: number, stored: number, counted: number, registrations: number];

export const MEASURED = {
  date: "2026-11-06",
  q0: [[5016, 0, "2026-10-20 16:42:50", "2026-11-06 08:45:06", "2026-11-06 09:06:33", 480]] satisfies Q0Row[],
  q1: [[5016, 2508, 0, 3182, 54, 4562, 43, 5016]] satisfies Q1Row[],
  q2: [
    ["1", 2464, 2464, 1],
    ["2-9", 35, 107, 9],
    ["10-49", 2, 39, 22],
    ["50-99", 1, 56, 56],
    ["100-999", 5, 1350, 868],
    ["1000+", 1, 1000, 1000],
  ] satisfies Q2Row[],
  q3: [
    [1, 1000, 0, 0, 0, 1000],
    [2, 868, 868, 868, 1, 868],
    [3, 144, 0, 0, 0, 1],
    [4, 136, 0, 0, 0, 1],
    [5, 102, 0, 0, 0, 1],
    [6, 100, 100, 100, 1, 100],
    [7, 56, 56, 56, 1, 56],
  ] satisfies Q3Row[],
  q4: [
    [0, 4],
    [1, 2000],
    [2, 868],
    [3, 115],
    [4, 56],
    [5, 23],
  ] satisfies Q4Row[],
  q5: [
    ["1", 4548, 4548, 1, 3154],
    ["2-9", 11, 25, 5, 12],
    ["10-49", 1, 16, 16, 16],
    ["50+", 1, 384, 384, 0],
  ] satisfies Q5Row[],
  q6: [[5016, 3948, 1065, 6, 0, 2]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 49],
    [1, "listed", "-", 480],
    [2, "held out as shared", "host shared by 50 or more", 3023],
    [2, "held out as shared", "profile link shared by 2 or more", 425],
    [2, "held out as shared", "wallet that registered 10 or more", 1039],
  ] satisfies Q7Row[],
  q8: [[5016, 5016, 5016, 2900, 2791, 2900, 2791, 346, 339]] satisfies Q8Row[],
  q9: [
    ["mint", 5016, 5016, 21156191, 29806856],
    ["secondary", 2900, 2900, 22313910, 29173360],
    ["uri_update", 346, 339, 21214757, 29628832],
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
    [34, 35],
    [35, 46],
    [36, 26],
    [37, 15],
    [38, 34],
    [39, 36],
    [40, 11],
    [41, 44],
    [42, 33],
    [43, 8],
    [44, 9],
    [45, 765],
    [46, 1304],
    [47, 10],
    [48, 10],
    [49, 30],
    [50, 16],
  ] satisfies Q10Row[],
  q11: [[1, 380736, "2026-11-06 09:06:33"]] satisfies Q11Row[],
  q12: [
    [1, 2000, 380736, 382736],
    [2, 868, 0, 868],
    [3, 115, 0, 115],
    [4, 56, 0, 56],
    [5, 23, 0, 23],
  ] satisfies Q12Row[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const q0: Q0Row = MEASURED.q0[0];
const q1: Q1Row = MEASURED.q1[0];
const q6: Q6Row = MEASURED.q6[0];
const q8: Q8Row = MEASURED.q8[0];
const q11: Q11Row = MEASURED.q11[0];

/** A bucket the query did not return has nothing in it, so it reads as zero. */
const walletBucket = (name: string): Q2Row => MEASURED.q2.find(row => row[0] === name) ?? [name, 0, 0, 0];
const linkBucket = (name: string): Q5Row => MEASURED.q5.find(row => row[0] === name) ?? [name, 0, 0, 0, 0];
const host = (rank: number): number => MEASURED.q4.find(row => row[0] === rank)?.[1] ?? 0;
const listingRows = (listing: number): number => sum(MEASURED.q7.filter(row => row[0] === listing).map(row => row[3]));
const firstRule = (rule: string): number => sum(MEASURED.q7.filter(row => row[2] === rule).map(row => row[3]));

/** The registry as the directory holds it, named for what each figure is. */
export const REGISTRY = {
  /** The registrations the directory has stored. A host past the cap keeps only its first rows, so this is not all of the chain's. */
  registrations: q1[0],
  /** The registrations counted past a host's cap and not stored. */
  overflow: q11[1],
  /** What the directory counts on the chain: the registrations stored plus the registrations counted and not stored. */
  onChain: q1[0] + q11[1],
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

const sharedLinks = MEASURED.q5.filter(row => row[0] !== "1");
const bigLink = linkBucket("50+");
const links = sum(MEASURED.q5.map(row => row[1]));

const largestHost: Q12Row = MEASURED.q12[0];

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
    listedOfChainPercent: percent(listingRows(1), REGISTRY.onChain),
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
    /** The same registrations as a share of everything the directory counts on the chain, as the Arc page's share of who registered gives it. */
    largeOfChainPercent: percent(largeWalletRegistrations, REGISTRY.onChain),
    /** The registrations on the chain that the large wallets are not recorded against, and how they divide: stored against smaller wallets, or counted and not stored. */
    rest: REGISTRY.onChain - largeWalletRegistrations,
    restStored: registrations - largeWalletRegistrations,
    restCounted: REGISTRY.overflow,
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
  },
  /** Host names, by size, and the host row cap. A host past the cap keeps `CHAIN.hostRowCap` rows, so query 4 shows it at that size. */
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
    /** The hosts past the cap, and the registrations counted and not stored for them. */
    pastTheCap: q11[0],
    overflow: q11[1],
    overflowLargest: largestHost[2],
    /** What the host past the cap holds in all: the rows kept and the registrations counted, and that as a share of the registrations on the chain. */
    largestHeld: largestHost[3],
    largestHeldPercent: percent(largestHost[3], REGISTRY.onChain),
    overflowPercent: percent(q11[1], REGISTRY.onChain),
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
