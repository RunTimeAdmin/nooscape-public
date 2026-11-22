/**
 * Every figure on the Validation Registry note (/field/validation-registry-2026-11-20), in one place. The page reads only this file,
 * and client/src/pages/validationRegistryReport.test.ts fails if a number on the page is not one of these, if a row here differs from
 * the measurement document, or if a total here does not add up.
 *
 * MEASURED holds one row per chain exactly as the script read it (docs/validation-registry-census-2026-11-20.mjs; the record is
 * docs/validation-registry-census-2026-11-20.md). Nothing was recomputed or filtered after the run. A chain that could not be read has
 * no figures, only a reason, because "not read" is never the same as none. DERIVED holds the totals and the comparison the page
 * states, each worked out here from MEASURED and EARLIER, so the page writes no figure of its own.
 */
export const DOC = "docs/validation-registry-census-2026-11-20.md";
export const SCRIPT = "docs/validation-registry-census-2026-11-20.mjs";

/** When it was read: the UTC date of the run and the first day counted. The registry's first deployment was on 2026-01-10. */
export const RUN = { date: "2026-11-20", from: "2026-01-01" } as const;

/**
 * The registry the count is of. It is the same address on every chain that has it. `source` is where the reference implementation
 * publishes it; `testnetAddress` is the one it publishes for test networks, which also holds proxy code on some mainnets and is not this registry.
 */
export const REGISTRY = {
  address: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  implementation: "0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99",
  implementationBytes: 5876,
  testnetAddress: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  source: "MAINNET_ADDRESSES in scripts/addresses.ts of the erc-8004-contracts repository, commit 2fcc66421cef",
} as const;

export type ChainRead = "read" | "not-read" | "no-registry";
/** Whose request it is: the named validator was the agent's owner at the block of the request, was not, or the owner could not be read there. */
export type OwnerNamed = { validator: number; other: number; unknown: number };
export type ChainRow = {
  key: string;
  label: string;
  chainId: number;
  status: ChainRead;
  /** Why a chain was not read, or why the address holds another contract, in words. Null for a chain that was read or has no code at the address. */
  reason: string | null;
  headBlock: number | null;
  requests: number | null;
  responses: number | null;
  /** Different agents named in the requests, and different validators named. */
  agentsAsked: number | null;
  validatorsNamed: number | null;
  ownerAtRequest: OwnerNamed | null;
  /** UTC dates of the first and the last request or response, or null when there is none. */
  first: string | null;
  last: string | null;
  /**
   * The checks the read passed, for a chain that was read. a: the registry's implementation holds both event signatures. b: the unfiltered
   * read returned only requests, responses and the proxy's own admin events (Upgraded, OwnershipTransferred, Initialized). c: the last
   * Upgraded event's implementation is the one the proxy points to at the newest block.
   */
  controls: { a: boolean; b: boolean; c: boolean | null } | null;
};

export const MEASURED: readonly ChainRow[] = [
  { key: "celo", label: "Celo", chainId: 42220, status: "read", reason: null, headBlock: 83_237_399, requests: 21, responses: 17, agentsAsked: 1, validatorsNamed: 21, ownerAtRequest: { validator: 0, other: 21, unknown: 0 }, first: "2026-03-19", last: "2026-03-19", controls: { a: true, b: true, c: true } },
  { key: "base", label: "Base", chainId: 8453, status: "read", reason: null, headBlock: 59_738_892, requests: 18, responses: 15, agentsAsked: 7, validatorsNamed: 7, ownerAtRequest: { validator: 15, other: 3, unknown: 0 }, first: "2026-03-09", last: "2026-11-18", controls: { a: true, b: true, c: true } },
  { key: "0g", label: "0G", chainId: 16661, status: "read", reason: null, headBlock: 50_783_473, requests: 14, responses: 14, agentsAsked: 14, validatorsNamed: 1, ownerAtRequest: { validator: 14, other: 0, unknown: 0 }, first: "2026-07-15", last: "2026-07-15", controls: { a: true, b: true, c: true } },
  { key: "mantle", label: "Mantle", chainId: 5000, status: "read", reason: null, headBlock: 103_503_924, requests: 10, responses: 0, agentsAsked: 2, validatorsNamed: 2, ownerAtRequest: { validator: 10, other: 0, unknown: 0 }, first: "2026-06-18", last: "2026-06-26", controls: { a: true, b: true, c: true } },
  { key: "monad", label: "Monad", chainId: 143, status: "read", reason: null, headBlock: 123_736_595, requests: 5, responses: 5, agentsAsked: 4, validatorsNamed: 3, ownerAtRequest: { validator: 2, other: 3, unknown: 0 }, first: "2026-09-20", last: "2026-10-12", controls: { a: true, b: true, c: true } },
  { key: "abstract", label: "Abstract", chainId: 2741, status: "read", reason: null, headBlock: 89_426_463, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "arbitrum", label: "Arbitrum One", chainId: 42161, status: "read", reason: null, headBlock: 525_783_286, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "avalanche", label: "Avalanche C-Chain", chainId: 43114, status: "read", reason: null, headBlock: 100_829_008, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "bnb", label: "BNB Chain", chainId: 56, status: "read", reason: null, headBlock: 134_607_388, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "ethereum", label: "Ethereum", chainId: 1, status: "read", reason: null, headBlock: 26_453_023, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "goat", label: "GOAT Network", chainId: 2345, status: "read", reason: null, headBlock: 16_980_083, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "gnosis", label: "Gnosis", chainId: 100, status: "read", reason: null, headBlock: 49_368_923, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "linea", label: "Linea", chainId: 59144, status: "read", reason: null, headBlock: 32_657_726, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "megaeth", label: "MegaETH", chainId: 4326, status: "read", reason: null, headBlock: 32_341_151, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "metis", label: "Metis Andromeda", chainId: 1088, status: "read", reason: null, headBlock: 23_435_887, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "optimism", label: "Optimism", chainId: 10, status: "read", reason: null, headBlock: 159_769_688, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "polygon", label: "Polygon", chainId: 137, status: "read", reason: null, headBlock: 97_621_790, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "skale-base", label: "SKALE Base", chainId: 1187947933, status: "read", reason: null, headBlock: 3_393_881, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "scroll", label: "Scroll", chainId: 534352, status: "read", reason: null, headBlock: 35_790_321, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "taiko", label: "Taiko", chainId: 167000, status: "read", reason: null, headBlock: 14_247_041, requests: 0, responses: 0, agentsAsked: 0, validatorsNamed: 0, ownerAtRequest: { validator: 0, other: 0, unknown: 0 }, first: null, last: null, controls: { a: true, b: true, c: true } },
  { key: "injective", label: "Injective EVM", chainId: 1776, status: "not-read", reason: "Its public node timed out (HTTP 504) on more than 8 windows, the last at blocks 187,058,481 to 187,063,480, so the range could not be read in full.", headBlock: null, requests: null, responses: null, agentsAsked: null, validatorsNamed: null, ownerAtRequest: null, first: null, last: null, controls: null },
  { key: "xlayer", label: "X Layer", chainId: 196, status: "not-read", reason: "Its public nodes serve only 100 blocks a call, which would take 279,134 calls.", headBlock: null, requests: null, responses: null, agentsAsked: null, validatorsNamed: null, ownerAtRequest: null, first: null, last: null, controls: null },
  { key: "soneium", label: "Soneium", chainId: 1868, status: "no-registry", reason: "The contract there is not this registry: its code does not hold both of its event signatures.", headBlock: null, requests: null, responses: null, agentsAsked: null, validatorsNamed: null, ownerAtRequest: null, first: null, last: null, controls: null },
];

/**
 * Another reader's published count, as of 2026-10-13, with its code and controls: https://github.com/achemperety/erc8004-usage-2026-10-13.
 * `active` lists each chain where it found any request or response (Celo's figures were lower bounds there); `none` lists the other chains
 * it read that this note also reads, where it found none. The figures are copied from that repository's results table.
 */
export const EARLIER = {
  asOf: "2026-10-13",
  url: "https://github.com/achemperety/erc8004-usage-2026-10-13",
  active: [
    { key: "celo", requests: 21, responses: 17, lowerBound: true },
    { key: "base", requests: 15, responses: 12, lowerBound: false },
    { key: "0g", requests: 14, responses: 14, lowerBound: false },
    { key: "mantle", requests: 10, responses: 0, lowerBound: false },
    { key: "monad", requests: 5, responses: 5, lowerBound: false },
  ],
  none: ["ethereum", "optimism", "gnosis", "polygon", "metis", "goat", "abstract", "megaeth", "arbitrum", "avalanche", "linea", "taiko", "scroll", "skale-base"],
} as const;

const sum = (values: ReadonlyArray<number | null | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const rowOf = (key: string) => MEASURED.find(row => row.key === key);
const readRows = MEASURED.filter(row => row.status === "read");

/** Where this note's count and the earlier one can be set side by side, and whether they agree: equal, or higher here since (never lower; a lower bound counts as equal when it is met). */
const compared = [
  ...EARLIER.active.map(entry => ({ entry, row: rowOf(entry.key) })).filter(pair => pair.row?.status === "read"),
].map(({ entry, row }) => ({
  key: entry.key,
  same: entry.lowerBound ? row!.requests! >= entry.requests && row!.responses! >= entry.responses : row!.requests === entry.requests && row!.responses === entry.responses,
  lower: row!.requests! < entry.requests || row!.responses! < entry.responses,
}));
const comparedNone = EARLIER.none.map(key => rowOf(key)).filter(row => row?.status === "read");

export const DERIVED = {
  asked: MEASURED.length,
  withRegistry: MEASURED.filter(row => row.status !== "no-registry").length,
  read: readRows.length,
  notRead: MEASURED.filter(row => row.status === "not-read").length,
  noRegistry: MEASURED.filter(row => row.status === "no-registry").length,
  requests: sum(readRows.map(row => row.requests)),
  responses: sum(readRows.map(row => row.responses)),
  chainsWithAny: readRows.filter(row => (row.requests ?? 0) + (row.responses ?? 0) > 0).length,
  chainsWithNone: readRows.filter(row => row.requests === 0 && row.responses === 0).length,
  /** Whether all three checks held on every chain that was read. */
  controlsHeld: readRows.every(row => row.controls?.a === true && row.controls?.b === true && row.controls?.c === true),
  ownerNamed: sum(readRows.map(row => row.ownerAtRequest?.validator)),
  ownerOther: sum(readRows.map(row => row.ownerAtRequest?.other)),
  ownerUnknown: sum(readRows.map(row => row.ownerAtRequest?.unknown)),
  /** The chains both readers read, and on how many of them the two counts agree. */
  agreement: {
    compared: compared.length + comparedNone.length,
    same: compared.filter(pair => pair.same).length + comparedNone.filter(row => row!.requests === 0 && row!.responses === 0).length,
    lower: compared.filter(pair => pair.lower).length,
    /** Chains where this count is higher than the earlier one: requests or responses came after 2026-10-13. */
    higher: compared.filter(pair => !pair.same && !pair.lower).length + comparedNone.filter(row => row!.requests !== 0 || row!.responses !== 0).length,
  },
} as const;
