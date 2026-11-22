import { extraChainsOn, type ExtraChainKey } from "./chains";

/**
 * The "Today" block on a registry census page: the same counts the page's first table makes, read from the directory as it stands now,
 * beside the figures the report measured on its own date. The report is a dated measurement and does not change; this is the one part
 * of the page that does (docs/census-today-2026-11-06.md).
 */

/**
 * The census reports with a Today block: each chain's registry census, the Solana registry census (three registries in one report) and
 * the BNB Chain rating census (the ratings ledger, not a registry).
 */
export const CENSUS_CHAINS = ["arc", "base", "ethereum", "monad", "gnosis", "celo", "bnb", "robinhood", "solana", "bnb_ratings"] as const;
export type CensusChain = (typeof CENSUS_CHAINS)[number];

/**
 * Where a report's counts are read from. `rows` chains keep every registration in the registry rows table and list a part of them in the
 * directory; `entries` chains keep each registration as a directory entry. `solana` is the three Solana registries' entries, counted as
 * the Solana census counted them; `bsc_ratings` is the BNB Chain ratings ledger.
 */
export type CensusSource = { kind: "rows" | "entries"; protocol: string; ratingsKey: string | null } | { kind: "solana" } | { kind: "bsc_ratings" };

export const CENSUS_SOURCE: Record<CensusChain, CensusSource> = {
  arc: { kind: "rows", protocol: "erc8004_arc", ratingsKey: "arc" },
  base: { kind: "rows", protocol: "erc8004_base", ratingsKey: "base" },
  ethereum: { kind: "rows", protocol: "erc8004_eth", ratingsKey: "ethereum" },
  monad: { kind: "rows", protocol: "erc8004_monad", ratingsKey: "monad" },
  gnosis: { kind: "rows", protocol: "erc8004_gnosis", ratingsKey: "gnosis" },
  celo: { kind: "rows", protocol: "erc8004_celo", ratingsKey: "celo" },
  bnb: { kind: "rows", protocol: "erc8004_bsc", ratingsKey: null },
  robinhood: { kind: "entries", protocol: "erc8004", ratingsKey: null },
  solana: { kind: "solana" },
  bnb_ratings: { kind: "bsc_ratings" },
};

/** The three registries of the Solana census, in the order its first table lists them. AgenC came after the report and is not in it. */
export const SOLANA_CENSUS_REGISTRIES = ["solana_said", "solana_8004", "solana_registry"] as const;
export type SolanaCensusRegistry = (typeof SOLANA_CENSUS_REGISTRIES)[number];

/** The counts of the Solana census's first table, for one registry. */
export const SOLANA_CENSUS_FIGURES = ["entries", "wallets", "distinctLinks", "withHttpsHost", "hosts"] as const;
export type SolanaCensusFigure = (typeof SOLANA_CENSUS_FIGURES)[number];

/** The key a Solana count has in the answer: the registry, then the count ("solana_said.entries"). */
export const solanaFigureKey = (registry: SolanaCensusRegistry, figure: SolanaCensusFigure): string => `${registry}.${figure}`;

/** The counts of the BNB Chain rating census's ledger, as its document's first table gives them. */
export const BSC_RATINGS_FIGURES = ["events", "ratingsSent", "revocations", "ratingsStand", "senders", "raters", "agentsRated"] as const;
export type BscRatingsFigure = (typeof BSC_RATINGS_FIGURES)[number];

/** The counts of a census page's first table. A registry has the ones that mean something for it. */
export const CENSUS_FIGURES = ["onChain", "stored", "overflow", "listed", "wallets", "withHttpsHost", "hosts", "profileLinks"] as const;
export type CensusFigure = (typeof CENSUS_FIGURES)[number];

/** The words the census pages use for each count in their first table. */
export const CENSUS_FIGURE_LABEL: Record<CensusFigure, string> = {
  onChain: "Registrations the directory counts on the chain",
  stored: "Registrations the directory has stored",
  overflow: "Registrations counted past a host's cap and not stored",
  listed: "Registrations the directory lists",
  wallets: "Registering wallets",
  withHttpsHost: "Registrations with an https link",
  hosts: "Host names of those links",
  profileLinks: "Different profile links",
};

/** The count a page's label stands for, or null for a label this table does not use. */
export function censusFigureOfLabel(label: string): CensusFigure | null {
  return CENSUS_FIGURES.find(figure => CENSUS_FIGURE_LABEL[figure] === label) ?? null;
}

/** What the answer says about one chain. Counts only: no name, wallet, host or link. */
export type CensusToday = {
  chain: CensusChain;
  /** When the registry's source last finished a pass, as an ISO time, or null if it has not. */
  asOf: string | null;
  /** The counts that mean something for this report: a registry's by CensusFigure, the Solana census's by solanaFigureKey, the ratings ledger's by BscRatingsFigure. */
  figures: Partial<Record<string, number>>;
  /** Registrations the listing rules hold out, by where they stand now. Only for a registry that keeps its registrations in rows. */
  heldOut: { noLink: number; grouped: number; numericName: number; pending: number } | null;
  /** The ratings the chain's reputation registry holds, once the count has read the whole history, and null before. */
  ratings: number | null;
};

/** Whether a census is on: the original chains' reports always, an extra chain's while its switch is. */
export function censusChainOn(chain: CensusChain, features: string | undefined): boolean {
  if (chain === "bnb" || chain === "robinhood" || chain === "solana" || chain === "bnb_ratings") return true;
  return extraChainsOn(features).includes(chain as ExtraChainKey);
}
