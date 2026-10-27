/**
 * Every figure on the Solana registry census report (/field/solana-registries-2026-10-18), in one place. The page reads
 * only this file, and client/src/pages/solanaRegistryReport.test.ts fails if a number on the page is not one of these, if
 * one of these does not appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it
 * line by line. The document is docs/solana-census-2026-10-18.md and the queries are in
 * docs/solana-census-queries-2026-10-18.sql. Nothing was recomputed or filtered after the run. DERIVED holds the totals and
 * percentages the page states, each worked out here from MEASURED, so the page writes no figure of its own.
 */
export const SOLANA_DOC = "docs/solana-census-2026-10-18.md";

export const REGISTRIES = ["solana_said", "solana_8004", "solana_registry"] as const;
type RegistryKey = (typeof REGISTRIES)[number];

export const REGISTRY_LABEL: Record<RegistryKey, string> = { solana_said: "SAID", solana_8004: "8004", solana_registry: "Metaplex" };

/** One row of query 0: the visible entries of a registry, when a pass first and last saw one, and when its source last succeeded. */
export type Q0Row = readonly [protocol: RegistryKey, entries: number, firstSeen: string, lastSeen: string, lastSuccess: string];
/** One row of query 1: size and surface. */
export type Q1Row = readonly [protocol: RegistryKey, entries: number, wallets: number, noWallet: number, withLink: number, distinctLinks: number, withHttpsHost: number, hosts: number];
/** One row of queries 2 and 3: a size bucket, how many wallets (or links) fall in it, the entries they hold, and the largest holding in it. */
type BucketRow = readonly [protocol: RegistryKey, bucket: string, groups: number, entries: number, largest: number];
/** One row of query 4: the host names of a registry by size and never by name. Rank 0 is how many host names hold 50 or more entries. */
export type Q4Row = readonly [protocol: RegistryKey, hostRank: number, entries: number];
/** One row of query 5 (SAID only): a fact the chain records, its value, and the entries that carry it. */
export type Q5Row = readonly [facet: string, value: string, entries: number];
/** One row of query 6, first result (8004 only): agents in a size bucket of the registry's own feedback counter, and the ratings they hold. */
export type Q6Row = readonly [bucket: string, agents: number, ratings: number];
/** One row of query 8: names. */
export type Q8Row = readonly [protocol: RegistryKey, entries: number, placeholder: number, distinctNames: number, sharingAName: number, inNamesSharedBy10OrMore: number, largestNameGroup: number];
/** One row of query 9: wallets by how many registries they are recorded in. */
export type Q9Row = readonly [registries: number, wallets: number, entries: number];

export const MEASURED = {
  date: "2026-10-18",
  q0: [
    ["solana_registry", 1596, "2026-10-09 15:05:23", "2026-10-18 15:30:56", "2026-10-18 15:30:56"],
    ["solana_8004", 1506, "2026-10-12 03:04:41", "2026-10-18 16:00:08", "2026-10-18 16:00:08"],
    ["solana_said", 13779, "2026-10-13 15:38:40", "2026-10-18 15:30:33", "2026-10-18 15:30:35"],
  ] satisfies Q0Row[],
  q1: [
    ["solana_registry", 1596, 564, 0, 0, 0, 73, 7],
    ["solana_8004", 1506, 295, 0, 1506, 1089, 411, 51],
    ["solana_said", 13779, 13779, 0, 13779, 13776, 13778, 21],
  ] satisfies Q1Row[],
  q2: [
    ["solana_registry", "1", 460, 460, 1],
    ["solana_registry", "2-9", 90, 269, 8],
    ["solana_registry", "10-99", 11, 314, 97],
    ["solana_registry", "100-999", 3, 553, 332],
    ["solana_8004", "1", 212, 212, 1],
    ["solana_8004", "2-9", 65, 184, 8],
    ["solana_8004", "10-99", 15, 429, 76],
    ["solana_8004", "100-999", 3, 681, 326],
    ["solana_said", "1", 13779, 13779, 1],
  ] satisfies BucketRow[],
  q3: [
    ["solana_8004", "1", 1032, 1032, 1],
    ["solana_8004", "2-9", 52, 159, 9],
    ["solana_8004", "10-99", 3, 74, 41],
    ["solana_8004", "100+", 2, 241, 135],
    ["solana_said", "1", 13773, 13773, 1],
    ["solana_said", "2-9", 3, 6, 2],
  ] satisfies BucketRow[],
  q4: [
    ["solana_8004", 0, 2],
    ["solana_8004", 1, 142],
    ["solana_8004", 2, 141],
    ["solana_8004", 3, 40],
    ["solana_8004", 4, 22],
    ["solana_8004", 5, 7],
    ["solana_registry", 1, 43],
    ["solana_registry", 2, 16],
    ["solana_registry", 3, 6],
    ["solana_registry", 4, 3],
    ["solana_registry", 5, 2],
    ["solana_said", 0, 2],
    ["solana_said", 1, 13426],
    ["solana_said", 2, 256],
    ["solana_said", 3, 39],
    ["solana_said", 4, 21],
    ["solana_said", 5, 7],
  ] satisfies Q4Row[],
  q5: [
    ["badge", "badge: no", 298],
    ["badge", "badge: yes", 13481],
    ["layout", "layout v1", 1156],
    ["layout", "layout v2", 1635],
    ["layout", "layout v3", 10988],
    ["registered_month", "registered 2026-02", 27],
    ["registered_month", "registered 2026-03", 2561],
    ["registered_month", "registered 2026-04", 430],
    ["registered_month", "registered 2026-05", 1272],
    ["registered_month", "registered 2026-06", 1825],
    ["registered_month", "registered 2026-07", 686],
    ["registered_month", "registered 2026-08", 2913],
    ["registered_month", "registered 2026-09", 2357],
    ["registered_month", "registered 2026-10", 1708],
    ["slashes", "(not recorded: layouts 1 and 2)", 2791],
    ["slashes", "slashes: 0", 10988],
    ["stake", "(not recorded: layouts 1 and 2)", 2791],
    ["stake", "stake: none", 10984],
    ["stake", "stake: some", 4],
  ] satisfies Q5Row[],
  q6: [
    ["0", 333, 0],
    ["1-4", 875, 1870],
    ["5-19", 247, 2078],
    ["20-99", 19, 794],
    ["100+", 32, 5954],
  ] satisfies Q6Row[],
  /** Query 6, second result: the ratings held by the ten agents with the most, and by all agents. */
  q6Totals: { tenMost: 3410, all: 10696 },
  /** Query 7 (Metaplex only): how many entries carry each kind of note. The note is the one the Metaplex chain pass writes. */
  q7: [["On-chain Metaplex registry pass: identity PDA and Core asset owner/name are chain reads; no off-chain content fetched.", 1596]] as ReadonlyArray<readonly [string, number]>,
  q8: [
    ["solana_registry", 1596, 0, 1320, 362, 159, 71],
    ["solana_8004", 1506, 614, 690, 274, 76, 64],
    ["solana_said", 13779, 13619, 144, 27, 0, 4],
  ] satisfies Q8Row[],
  q9: [
    [1, 14577, 16793],
    [2, 29, 85],
    [3, 1, 3],
  ] satisfies Q9Row[],
} as const;

const q1 = (protocol: RegistryKey) => MEASURED.q1.find(row => row[0] === protocol)!;
const q8 = (protocol: RegistryKey) => MEASURED.q8.find(row => row[0] === protocol)!;
const bucket = (rows: readonly BucketRow[], protocol: RegistryKey, name: string) => rows.find(row => row[0] === protocol && row[1] === name);
const host = (protocol: RegistryKey, rank: number) => MEASURED.q4.find(row => row[0] === protocol && row[1] === rank)?.[2] ?? 0;
const q5 = (facet: string, value: string) => MEASURED.q5.find(row => row[0] === facet && row[1] === value)?.[2] ?? 0;
const q6 = (name: string) => MEASURED.q6.find(row => row[0] === name)!;
const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

/** What the page says about one registry, named for what it is. */
export const registry = (protocol: RegistryKey) => {
  const [, entries, wallets, , withLink, distinctLinks, withHttpsHost, hosts] = q1(protocol);
  return { entries, wallets, withLink, distinctLinks, withHttpsHost, hosts };
};

const wallets = (protocol: RegistryKey, name: string) => bucket(MEASURED.q2, protocol, name);
const links = (protocol: RegistryKey, name: string) => bucket(MEASURED.q3, protocol, name);

const entries8004 = registry("solana_8004").entries;
const entriesMetaplex = registry("solana_registry").entries;
const entriesSaid = registry("solana_said").entries;
const withHost8004 = registry("solana_8004").withHttpsHost;
const withHostMetaplex = registry("solana_registry").withHttpsHost;
const withHostSaid = registry("solana_said").withHttpsHost;
const w8004Large = (wallets("solana_8004", "10-99")?.[3] ?? 0) + (wallets("solana_8004", "100-999")?.[3] ?? 0);
const w8004LargeWallets = (wallets("solana_8004", "10-99")?.[2] ?? 0) + (wallets("solana_8004", "100-999")?.[2] ?? 0);
const l8004Shared = (links("solana_8004", "2-9")?.[3] ?? 0) + (links("solana_8004", "10-99")?.[3] ?? 0) + (links("solana_8004", "100+")?.[3] ?? 0);
const l8004TenOrMore = (links("solana_8004", "10-99")?.[2] ?? 0) + (links("solana_8004", "100+")?.[2] ?? 0);
const l8004TenOrMoreEntries = (links("solana_8004", "10-99")?.[3] ?? 0) + (links("solana_8004", "100+")?.[3] ?? 0);
const layout3 = q5("layout", "layout v3");
const olderLayouts = q5("layout", "layout v1") + q5("layout", "layout v2");
const badgeYes = q5("badge", "badge: yes");
const ratingsAll = MEASURED.q6Totals.all;
const ratings100 = q6("100+")[2];

export const DERIVED = {
  /** The three registries together. */
  totalEntries: entriesSaid + entries8004 + entriesMetaplex,
  /** 8004 and Metaplex: the wallets that hold 100 or more entries each, and the three largest wallets' share. */
  wallets8004: {
    holdingMost: wallets("solana_8004", "100-999")![2],
    holdingMostEntries: wallets("solana_8004", "100-999")![3],
    holdingMostPercent: percent(wallets("solana_8004", "100-999")![3], entries8004),
    holdingTenOrMore: w8004LargeWallets,
    holdingTenOrMoreEntries: w8004Large,
    holdingTenOrMorePercent: percent(w8004Large, entries8004),
    largest: wallets("solana_8004", "100-999")![4],
    largestPercent: percent(wallets("solana_8004", "100-999")![4], entries8004),
  },
  walletsMetaplex: {
    holdingMost: wallets("solana_registry", "100-999")![2],
    holdingMostEntries: wallets("solana_registry", "100-999")![3],
    holdingMostPercent: percent(wallets("solana_registry", "100-999")![3], entriesMetaplex),
    largest: wallets("solana_registry", "100-999")![4],
    largestPercent: percent(wallets("solana_registry", "100-999")![4], entriesMetaplex),
  },
  /** 8004 links. */
  links8004: {
    entriesSharingALink: l8004Shared,
    entriesSharingALinkPercent: percent(l8004Shared, entries8004),
    linksSharedByTenOrMore: l8004TenOrMore,
    entriesInThoseLinks: l8004TenOrMoreEntries,
    entriesInThoseLinksPercent: percent(l8004TenOrMoreEntries, entries8004),
    largestGroup: links("solana_8004", "100+")![4],
    notHttps: entries8004 - withHost8004,
  },
  /** Host names, by size. */
  hosts: {
    saidLargest: host("solana_said", 1),
    saidLargestPercent: percent(host("solana_said", 1), withHostSaid),
    saidSecond: host("solana_said", 2),
    saidWithoutHost: entriesSaid - withHostSaid,
    saidHostsOver50: host("solana_said", 0),
    e8004TwoLargest: host("solana_8004", 1) + host("solana_8004", 2),
    e8004TwoLargestPercent: percent(host("solana_8004", 1) + host("solana_8004", 2), withHost8004),
    e8004First: host("solana_8004", 1),
    e8004Second: host("solana_8004", 2),
    e8004HostsOver50: host("solana_8004", 0),
    metaplexLargest: host("solana_registry", 1),
    metaplexLargestPercent: percent(host("solana_registry", 1), withHostMetaplex),
    metaplexWithoutHost: entriesMetaplex - withHostMetaplex,
  },
  /** SAID. */
  said: {
    badgeYes: badgeYes,
    badgePercent: percent(badgeYes, entriesSaid),
    layoutNewest: layout3,
    olderLayouts,
    stakeNone: q5("stake", "stake: none"),
    stakeSome: q5("stake", "stake: some"),
    slashesZero: q5("slashes", "slashes: 0"),
  },
  /** 8004 ratings. */
  ratings: {
    all: ratingsAll,
    agentsWithNone: q6("0")[1],
    agentsWith100OrMore: q6("100+")[1],
    ratingsOfThose: ratings100,
    ratingsOfThosePercent: percent(ratings100, ratingsAll),
    tenMost: MEASURED.q6Totals.tenMost,
    tenMostPercent: percent(MEASURED.q6Totals.tenMost, ratingsAll),
  },
  /** Names. */
  names: {
    metaplexDistinct: q8("solana_registry")[3],
    metaplexSharing: q8("solana_registry")[4],
    metaplexSharingPercent: percent(q8("solana_registry")[4], entriesMetaplex),
    e8004Placeholder: q8("solana_8004")[2],
    e8004PlaceholderPercent: percent(q8("solana_8004")[2], entries8004),
    e8004Named: entries8004 - q8("solana_8004")[2],
    e8004Distinct: q8("solana_8004")[3],
    e8004Sharing: q8("solana_8004")[4],
    saidPlaceholder: q8("solana_said")[2],
    saidNamed: entriesSaid - q8("solana_said")[2],
  },
  /** SAID links shared by identities. */
  saidSharedLinks: links("solana_said", "2-9")![2],
  saidSharedLinksEntries: links("solana_said", "2-9")![3],
  /** Wallets by how many registries they are recorded in. */
  crossRegistry: {
    one: MEASURED.q9.find(row => row[0] === 1)!,
    two: MEASURED.q9.find(row => row[0] === 2)!,
    three: MEASURED.q9.find(row => row[0] === 3)!,
  },
} as const;

/** The months SAID identities were registered in, as the chain records them, with the identities of each. */
export const SAID_REGISTRATION_MONTHS = MEASURED.q5.filter(row => row[0] === "registered_month").map(row => ({ month: row[1].replace("registered ", ""), entries: row[2] }));

/** The earliest and latest time (UTC, hours and minutes) a source last succeeded, which says which passes the census was counted from. */
export const PASS_WINDOW = (() => {
  const times = MEASURED.q0.map(row => row[4].slice(11, 16)).sort();
  return `${times[0]} to ${times[times.length - 1]} UTC`;
})();
