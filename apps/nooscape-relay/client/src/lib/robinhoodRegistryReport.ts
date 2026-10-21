/**
 * Every figure on the Robinhood Chain registry census report (/field/robinhood-registry-2026-10-20), in one place. The page
 * reads only this file, and client/src/pages/robinhoodRegistryReport.test.ts fails if a number on the page is not one of
 * these, if one of these does not appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it
 * line by line. The document is docs/robinhood-census-2026-10-20.md and the queries are in
 * docs/robinhood-census-queries-2026-10-20.sql. Nothing was recomputed or filtered after the run. DERIVED holds the totals and
 * percentages the page states, each worked out here from MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest, so it can sit beside the Robinhood Chain page's share of the
 * same entries, which that page rounds down to a whole number.
 */
export const ROBINHOOD_DOC = "docs/robinhood-census-2026-10-20.md";
export const ROBINHOOD_SQL = "docs/robinhood-census-queries-2026-10-20.sql";

/** The thresholds the queries use: a wallet counts as large from this many entries, a host name from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 100, largeHost: 50, sharedName: 10 } as const;

/** Query 0: the visible entries, when a pass first and last saw one, and when the registry's source last succeeded. */
export type Q0Row = readonly [entries: number, firstSeen: string, lastSeen: string, lastSuccess: string];
/** Query 1: size and surface. */
export type Q1Row = readonly [entries: number, wallets: number, noWallet: number, withHttpsHost: number, hosts: number, mintMeasured: number];
/** Query 2: a size bucket of entries held by one wallet, how many wallets fall in it, the entries they hold, and the largest holding in it. */
export type Q2Row = readonly [bucket: string, wallets: number, entries: number, largest: number];
/** Query 3: the wallets that hold the large-wallet threshold or more, by size and never by address. */
export type Q3Row = readonly [walletRank: number, entries: number, withHttpsHost: number, onItsLargestHost: number, hosts: number];
/** Query 4: the host names by size and never by name. Rank 0 is how many host names hold the large-host threshold or more entries. */
export type Q4Row = readonly [hostRank: number, entries: number];
/** Query 5: names. */
export type Q5Row = readonly [entries: number, placeholder: number, distinctNames: number, sharingAName: number, inNamesSharedBy10OrMore: number, largestNameGroup: number];
/** Query 6: the totals the directory keeps for each entry's chain activity. */
export type Q6Row = readonly [
  entries: number,
  mintMeasured: number,
  coveredByTheWalk: number,
  transfersAfterMint: number,
  handouts: number,
  entriesThatChangedHands: number,
  entriesHandedOut: number,
  profileLinkEdits: number,
  entriesEdited: number,
];
/** Query 6b: entries by how many transfers after the mint, or profile-link edits, they have had. */
export type Q6bRow = readonly [what: "transfers" | "edits", perEntry: string, entries: number];
/** Query 7: the activity ledger by kind of event. */
export type Q7Row = readonly [kind: string, events: number, entries: number, oldestBlock: number, newestBlock: number];
/** Query 8: the reputation ledger by kind of event. */
export type Q8Row = readonly [kind: string, events: number, agents: number, wallets: number, oldestBlock: number, newestBlock: number];
/** Query 9: ratings per agent and per rating wallet, in size buckets. */
export type Q9Row = readonly [side: "agents" | "wallets", ratingsEach: string, members: number, ratings: number, largest: number];

export const MEASURED = {
  date: "2026-10-20",
  q0: [[9191, "2026-10-09 15:06:10", "2026-10-20 02:15:27", "2026-10-20 02:15:27"]] satisfies Q0Row[],
  q1: [[9191, 771, 0, 8679, 40, 9191]] satisfies Q1Row[],
  q2: [
    ["1", 645, 645, 1],
    ["2-9", 107, 254, 9],
    ["10-99", 13, 155, 19],
    ["100-999", 4, 1453, 902],
    ["1000+", 2, 6684, 5593],
  ] satisfies Q2Row[],
  q3: [
    [1, 5593, 5593, 5593, 1],
    [2, 1091, 1087, 1004, 3],
    [3, 902, 902, 902, 1],
    [4, 318, 318, 318, 1],
    [5, 133, 133, 133, 1],
    [6, 100, 100, 100, 1],
  ] satisfies Q3Row[],
  q4: [
    [0, 10],
    [1, 5593],
    [2, 1008],
    [3, 904],
    [4, 318],
    [5, 166],
  ] satisfies Q4Row[],
  q5: [[9191, 8064, 1053, 118, 0, 8]] satisfies Q5Row[],
  q6: [[9191, 9191, 9191, 6906, 6892, 6901, 6892, 462, 401]] satisfies Q6Row[],
  q6b: [
    ["edits", "0", 8790],
    ["edits", "1", 350],
    ["edits", "2-4", 50],
    ["edits", "5+", 1],
    ["transfers", "0", 2290],
    ["transfers", "1", 6897],
    ["transfers", "2-4", 4],
  ] satisfies Q6bRow[],
  q7: [
    ["mint", 9191, 9191, 34617968, 93089592],
    ["secondary", 6906, 6901, 57613251, 93090785],
    ["uri_update", 462, 401, 45060417, 92894075],
  ] satisfies Q7Row[],
  q8: [
    ["new_feedback", 642, 310, 8, 38854662, 86073111],
    ["feedback_revoked", 137, 135, 1, 79647610, 85203168],
  ] satisfies Q8Row[],
  q9: [
    ["agents", "1", 114, 114, 1],
    ["agents", "2-4", 196, 528, 4],
    ["wallets", "1", 3, 3, 1],
    ["wallets", "2-4", 2, 5, 3],
    ["wallets", "20-99", 1, 50, 50],
    ["wallets", "100+", 2, 584, 336],
  ] satisfies Q9Row[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const q0: Q0Row = MEASURED.q0[0];
const q1: Q1Row = MEASURED.q1[0];
const q5: Q5Row = MEASURED.q5[0];
const q6: Q6Row = MEASURED.q6[0];

/** A bucket the query did not return has no wallets in it, so it reads as zero. */
const walletBucket = (name: string): Q2Row => MEASURED.q2.find(row => row[0] === name) ?? [name, 0, 0, 0];
const host = (rank: number): number => MEASURED.q4.find(row => row[0] === rank)?.[1] ?? 0;
const perEntry = (what: "transfers" | "edits", name: string): number => MEASURED.q6b.find(row => row[0] === what && row[1] === name)?.[2] ?? 0;
const reputation = (kind: string): Q8Row => MEASURED.q8.find(row => row[0] === kind) ?? [kind, 0, 0, 0, 0, 0];
const ratingRows = (side: "agents" | "wallets"): Q9Row[] => MEASURED.q9.filter(row => row[0] === side);

/** The registry as the directory holds it, named for what each figure is. */
export const REGISTRY = {
  entries: q1[0],
  wallets: q1[1],
  noWallet: q1[2],
  withHttpsHost: q1[3],
  hosts: q1[4],
  mintMeasured: q1[5],
};

const entries = REGISTRY.entries;
const large = walletBucket("100-999");
const thousand = walletBucket("1000+");
const ten = walletBucket("10-99");
const one = walletBucket("1");
const largeWallets = large[1] + thousand[1];
const largeEntries = large[2] + thousand[2];
const tenOrMoreWallets = ten[1] + largeWallets;
const tenOrMoreEntries = ten[2] + largeEntries;

const largestWallet: Q3Row = MEASURED.q3[0];
const wallets: readonly Q3Row[] = MEASURED.q3;
const walletsOnOneHost = wallets.filter(row => row[4] === 1 && row[1] === row[2] && row[2] === row[3]);
const walletsOnSeveralHosts = wallets.filter(row => row[4] > 1);

const transfers = q6[3];
const handouts = q6[4];
const changedHands = q6[5];
const handedOut = q6[6];
const edits = q6[7];
const edited = q6[8];

const written = reputation("new_feedback");
const revoked = reputation("feedback_revoked");
const byAgent = ratingRows("agents");
const byWallet = ratingRows("wallets");
const biggestBucket = byWallet[byWallet.length - 1] ?? ["wallets", "", 0, 0, 0];

export const DERIVED = {
  /** Which wallets hold the entries. */
  wallets: {
    withOne: one[1],
    withOnePercent: percent(one[1], REGISTRY.wallets),
    withOneEntries: one[2],
    withOneEntriesPercent: percent(one[2], entries),
    large: largeWallets,
    largeEntries,
    largePercent: percent(largeEntries, entries),
    tenOrMore: tenOrMoreWallets,
    tenOrMoreEntries,
    tenOrMorePercent: percent(tenOrMoreEntries, entries),
    thousandOrMore: thousand[1],
    thousandOrMoreEntries: thousand[2],
    thousandOrMorePercent: percent(thousand[2], entries),
    largest: thousand[3],
    largestPercent: percent(thousand[3], entries),
  },
  /** The wallets that hold the large-wallet threshold or more, and how far their entries are spread across host names. */
  largeWallets: {
    onOneHost: walletsOnOneHost.length,
    onSeveralHosts: walletsOnSeveralHosts.length,
    /** The one wallet (if there is only one) that uses several host names: its host names, its entries with an https link and the part on the largest. */
    severalHosts: walletsOnSeveralHosts[0]?.[4] ?? 0,
    severalWithHttps: walletsOnSeveralHosts[0]?.[2] ?? 0,
    severalOnLargest: walletsOnSeveralHosts[0]?.[3] ?? 0,
    largestWalletEntries: largestWallet[1],
    /**
     * True when the largest wallet's entries are the whole of the largest host name. The wallet's entries all have an https link and
     * all sit on one host name, so that host name holds at least that many; no host name holds more than the largest, which holds
     * exactly that many, and the next is smaller, so it is one host name and no other wallet's entry is on it.
     */
    largestWalletIsLargestHost:
      largestWallet[4] === 1 && largestWallet[1] === largestWallet[2] && largestWallet[1] === largestWallet[3] && largestWallet[1] === host(1) && host(1) > host(2),
  },
  /** Host names, by size. */
  hosts: {
    withHttps: REGISTRY.withHttpsHost,
    withHttpsPercent: percent(REGISTRY.withHttpsHost, entries),
    withoutHost: entries - REGISTRY.withHttpsHost,
    withoutHostPercent: percent(entries - REGISTRY.withHttpsHost, entries),
    largest: host(1),
    largestPercent: percent(host(1), REGISTRY.withHttpsHost),
    second: host(2),
    twoLargest: host(1) + host(2),
    twoLargestPercent: percent(host(1) + host(2), REGISTRY.withHttpsHost),
    atLeastThreshold: host(0),
  },
  /** Names. */
  names: {
    placeholder: q5[1],
    placeholderPercent: percent(q5[1], entries),
    named: entries - q5[1],
    distinct: q5[2],
    sharing: q5[3],
    sharingPercent: percent(q5[3], entries),
    sharedByTenOrMore: q5[4],
    largestGroup: q5[5],
  },
  /** What the chain records for each entry: transfers after the mint, hand-outs and profile-link edits. */
  activity: {
    measured: q6[2],
    transfers,
    changedHands,
    changedHandsPercent: percent(changedHands, entries),
    noTransfer: perEntry("transfers", "0"),
    noTransferPercent: percent(perEntry("transfers", "0"), entries),
    handouts,
    handedOut,
    handedOutPercent: percent(handedOut, entries),
    /** Transfers that were not a hand-out: they came later than the first hour, or from a wallet other than the one the entry was minted to. */
    laterTransfers: transfers - handouts,
    edits,
    edited,
    editedPercent: percent(edited, entries),
    editedOnce: perEntry("edits", "1"),
    editedTwoToFour: perEntry("edits", "2-4"),
    editedFiveOrMore: perEntry("edits", "5+"),
  },
  /** The reputation ledger. */
  ratings: {
    written: written[1],
    agentsRated: written[2],
    raters: written[3],
    revoked: revoked[1],
    revokedAgents: revoked[2],
    revokers: revoked[3],
    agentsWithOne: byAgent.find(row => row[1] === "1")?.[2] ?? 0,
    agentsWithOnePercent: percent(byAgent.find(row => row[1] === "1")?.[2] ?? 0, written[2]),
    mostPerAgent: Math.max(0, ...byAgent.map(row => row[4])),
    biggestRatersBucket: biggestBucket[1],
    biggestRaters: biggestBucket[2],
    biggestRatersRatings: biggestBucket[3],
    biggestRatersPercent: percent(biggestBucket[3], written[1]),
    largestRater: biggestBucket[4],
    largestRaterPercent: percent(biggestBucket[4], written[1]),
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[3].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
