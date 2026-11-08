import { extraChainsOn, type ExtraChainKey } from "./chains";

/**
 * The "Today" block on a registry census page: the same counts the page's first table makes, read from the directory as it stands now,
 * beside the figures the report measured on its own date. The report is a dated measurement and does not change; this is the one part
 * of the page that does (docs/census-today-2026-11-06.md).
 */

/** The chains with a registry census report that has a Today block. */
export const CENSUS_CHAINS = ["arc", "base", "ethereum", "monad", "gnosis", "bnb", "robinhood"] as const;
export type CensusChain = (typeof CENSUS_CHAINS)[number];

/**
 * Where a chain's registrations are kept and which source they belong to. `rows` chains keep every registration in the registry rows
 * table and list a part of them in the directory; `entries` chains keep each registration as a directory entry.
 */
export const CENSUS_SOURCE: Record<CensusChain, { kind: "rows" | "entries"; protocol: string; ratingsKey: string | null }> = {
  arc: { kind: "rows", protocol: "erc8004_arc", ratingsKey: "arc" },
  base: { kind: "rows", protocol: "erc8004_base", ratingsKey: "base" },
  ethereum: { kind: "rows", protocol: "erc8004_eth", ratingsKey: "ethereum" },
  monad: { kind: "rows", protocol: "erc8004_monad", ratingsKey: "monad" },
  gnosis: { kind: "rows", protocol: "erc8004_gnosis", ratingsKey: "gnosis" },
  bnb: { kind: "rows", protocol: "erc8004_bsc", ratingsKey: null },
  robinhood: { kind: "entries", protocol: "erc8004", ratingsKey: null },
};

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
  /** The counts that mean something for this registry. */
  figures: Partial<Record<CensusFigure, number>>;
  /** Registrations the listing rules hold out, by where they stand now. Only for a registry that keeps its registrations in rows. */
  heldOut: { noLink: number; grouped: number; numericName: number; pending: number } | null;
  /** The ratings the chain's reputation registry holds, once the count has read the whole history, and null before. */
  ratings: number | null;
};

/** Whether a chain's census is on: the original two always, an extra chain while its switch is. */
export function censusChainOn(chain: CensusChain, features: string | undefined): boolean {
  if (chain === "bnb" || chain === "robinhood") return true;
  return extraChainsOn(features).includes(chain as ExtraChainKey);
}
