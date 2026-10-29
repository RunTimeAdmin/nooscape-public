import { featureOn, type Feature } from "./features";

/**
 * Which chain each protocol belongs to, and the per-chain figures built from the
 * directory's own reads. Pure and shared, so the server that builds the figures and
 * the page that labels them agree on the mapping.
 *
 * The mapping is the one the directory already uses: the ERC-8004 identity registry
 * on Robinhood Chain is `erc8004` (and its reputation and USDG settlement ledgers
 * belong to that chain too), the four Solana registries are `solana_registry`,
 * `solana_8004`, `solana_said` and `solana_agenc`, and the BNB Chain registry is `erc8004_bsc`.
 * Locator protocols (A2A, the catalog and the census) are on no chain.
 */
export type ChainKey = "robinhood" | "solana" | "bnb";

export const CHAINS: readonly ChainKey[] = ["robinhood", "solana", "bnb"];

export const CHAIN_LABEL: Record<ChainKey, string> = {
  robinhood: "Robinhood Chain",
  solana: "Solana",
  bnb: "BNB Chain",
};

const CHAIN_OF_PROTOCOL: Record<string, ChainKey> = {
  erc8004: "robinhood",
  erc8004_reputation: "robinhood",
  usdg_settlement: "robinhood",
  solana_registry: "solana",
  solana_8004: "solana",
  solana_said: "solana",
  solana_agenc: "solana",
  erc8004_bsc: "bnb",
};

/** The chain a protocol is on, or null for a protocol that is on none. */
export function chainOf(protocol: string): ChainKey | null {
  return CHAIN_OF_PROTOCOL[protocol] ?? null;
}

/** The protocols that are on a chain, in no particular order. */
export function protocolsOf(chain: ChainKey): string[] {
  return Object.entries(CHAIN_OF_PROTOCOL).flatMap(([protocol, onChain]) => (onChain === chain ? [protocol] : []));
}

/**
 * Ethereum, Base and Arc: the chains the ERC-8004 identity pass reads besides the three above (docs/multichain-erc8004-2026-10-20.md).
 * Each is behind a switch in `VITE_FEATURES` that is off until the owner turns it on, and while it is off nothing of it is listed,
 * counted or served. They are kept apart from {@link ChainKey} on purpose: a chain in that list gets a map light, a page and a
 * place in the Owl's Catch, and an extra chain takes each of those on its own. Arc has a page (`WorldKey` in
 * client/src/lib/chainExplorerModel.ts), map lights (`MapChainKey`), a share card, a census report and, behind `claims_arc`, claims
 * (docs/chain-worlds-2026-10-20.md and the arc-*.md records it links). Every extra chain that is on is in "just arrived", in the
 * Owl's Catch's round numbers and in the watchlist and the webhook, and is otherwise listed and counted.
 */
export type ExtraChainKey = "ethereum" | "base" | "arc";

/** Every chain the directory lists: the three that need no switch, then the extra ones. */
export type ListedChainKey = ChainKey | ExtraChainKey;

/** The extra chains in the order the tabs and the API list them. */
export const EXTRA_CHAINS: readonly ExtraChainKey[] = ["ethereum", "base", "arc"];

export const EXTRA_CHAIN_LABEL: Record<ExtraChainKey, string> = {
  ethereum: "Ethereum",
  base: "Base",
  arc: "Arc",
};

/** The switch that turns each extra chain on (shared/features.ts). */
export const EXTRA_CHAIN_SWITCH: Record<ExtraChainKey, Feature> = {
  ethereum: "chain_ethereum",
  base: "chain_base",
  arc: "chain_arc",
};

const EXTRA_CHAIN_OF_PROTOCOL: Record<string, ExtraChainKey> = {
  erc8004_eth: "ethereum",
  erc8004_base: "base",
  erc8004_arc: "arc",
};

/** The extra chains whose switch is on in this list, in {@link EXTRA_CHAINS} order. Empty for an unset list. */
export function extraChainsOn(features: string | undefined): ExtraChainKey[] {
  return EXTRA_CHAINS.filter(chain => featureOn(EXTRA_CHAIN_SWITCH[chain], features));
}

/** The chains the directory lists under this switch list: the original three, then each extra chain that is on. */
export function listedChains(features: string | undefined): ListedChainKey[] {
  return [...CHAINS, ...extraChainsOn(features)];
}

/** The chain a protocol is on, counting the extra chains too, or null for a protocol that is on none. */
export function listedChainOf(protocol: string): ListedChainKey | null {
  return chainOf(protocol) ?? EXTRA_CHAIN_OF_PROTOCOL[protocol] ?? null;
}

/** The directory protocol of an extra chain's identity registry. */
export function extraProtocolOf(chain: ExtraChainKey): string {
  return Object.keys(EXTRA_CHAIN_OF_PROTOCOL).find(protocol => EXTRA_CHAIN_OF_PROTOCOL[protocol] === chain)!;
}

/** The protocols of the extra chains whose switch is off in this list: the ones no public read may show. */
export function protocolsOfChainsOff(features: string | undefined): string[] {
  const on = new Set(extraChainsOn(features));
  return Object.keys(EXTRA_CHAIN_OF_PROTOCOL).filter(protocol => !on.has(EXTRA_CHAIN_OF_PROTOCOL[protocol]!));
}

/** The name a chain goes by, for any listed chain. */
export function listedChainLabel(chain: ListedChainKey): string {
  return chain === "ethereum" || chain === "base" || chain === "arc" ? EXTRA_CHAIN_LABEL[chain] : CHAIN_LABEL[chain];
}

/** The `protocols` text a reviewed record stores (a JSON array of strings); anything else is no protocols. */
export function parseProtocolList(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export type ChainStat = {
  chain: ChainKey;
  /** At least one approved, active source for this chain. A chain with none is not measured, not zero. */
  indexed: boolean;
  /** Entries the directory acknowledges on this chain, under its visibility rules; null while the chain is not indexed. */
  acknowledged: number | null;
  /** Reviewed public records that list a protocol on this chain; null while the chain is not indexed. */
  reviewed: number | null;
  /**
   * Ratings recorded on-chain for the chain's identities, where they are read; null where they are not measured. On Robinhood
   * Chain this is the reputation ledger. On Solana it is the 8004 registry's own feedback counters, summed: SAID and Metaplex
   * keep no ratings that Nooscape reads, and AgenC's reputation counter is not counted. On Ethereum, Base and Arc it is the count of
   * the reputation registry's NewFeedback events (docs/extra-chain-ratings-2026-10-21.md), shown once the read has reached the finalized head.
   */
  feedbackEvents: number | null;
  /** The registries behind the chain's entries and how many each lists, largest first; empty while the chain is not indexed. */
  registries: Array<{ protocol: string; count: number }>;
  /** When a source for this chain last succeeded (ISO 8601), or null if none has. */
  asOf: string | null;
};

export type ChainStatsInput = {
  /** The directory's visible entries by protocol (`breakdownAgentDirectoryByProtocol`). */
  byProtocol: ReadonlyArray<{ protocol: string; count: number }>;
  /** The `protocols` of every reviewed public record, already parsed. */
  reviewedProtocols: ReadonlyArray<readonly string[]>;
  /** Ratings recorded against visible Robinhood identities, or null where the reputation ledger is not read. */
  robinhoodFeedback: number | null;
  /** The sum of the feedback counters of the visible 8004 Solana accounts, or null where none has been read. */
  solanaFeedback?: number | null;
  /**
   * Ratings counted in a chain's own reputation registry (the extra chains' ratings step), by chain key. A chain is here only once its read
   * has reached the finalized head, so a partial count is never shown; a chain that is not here is not measured.
   */
  chainFeedback?: Partial<Record<string, number>>;
  sources: ReadonlyArray<{ protocol: string; state: string; lastSuccessfulAt: Date | string | null }>;
};

const toIso = (value: Date | string | null) => {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The figures every chain has, from the directory's own reads. */
function statFor(chain: ListedChainKey, input: ChainStatsInput): Omit<ChainStat, "chain"> {
  const mine = input.sources.filter(source => listedChainOf(source.protocol) === chain);
  const indexed = mine.some(source => source.state === "active");
  const newest = mine
    .filter(source => source.state === "active")
    .map(source => toIso(source.lastSuccessfulAt))
    .filter((value): value is string => value !== null)
    .sort()
    .pop();
  const acknowledged = input.byProtocol.filter(entry => listedChainOf(entry.protocol) === chain).reduce((sum, entry) => sum + entry.count, 0);
  // A record is counted once for a chain however many of its protocols are on it.
  const reviewed = input.reviewedProtocols.filter(protocols => protocols.some(protocol => listedChainOf(protocol) === chain)).length;
  const feedbackEvents = !indexed ? null : chain === "robinhood" ? input.robinhoodFeedback : chain === "solana" ? (input.solanaFeedback ?? null) : (input.chainFeedback?.[chain] ?? null);
  const registries = input.byProtocol
    .filter(entry => listedChainOf(entry.protocol) === chain && entry.count > 0)
    .map(entry => ({ protocol: entry.protocol, count: entry.count }))
    .sort((left, right) => right.count - left.count);
  return {
    indexed,
    acknowledged: indexed ? acknowledged : null,
    reviewed: indexed ? reviewed : null,
    feedbackEvents,
    registries: indexed ? registries : [],
    asOf: newest ?? null,
  };
}

/** One row per chain, always in the order of {@link CHAINS}. */
export function buildChainStats(input: ChainStatsInput): ChainStat[] {
  return CHAINS.map(chain => ({ chain, ...statFor(chain, input) }));
}

/**
 * What an extra chain's tab adds to the figures every chain has: how many registrations the chain's registry holds and how many of
 * them the directory lists. The rest are held out by the chain's published listing rules, and held out is not judged. Null until a
 * pass that reached the chain's finalized head has published, because before that the stored count is only a part of the chain.
 */
export type RegistryProfile = { recorded: number; listed: number };

/** An extra chain's row: the figures of {@link ChainStat}, with the registry's recorded and listed counts. */
export type ExtraChainStat = Omit<ChainStat, "chain"> & { chain: ExtraChainKey; registry: RegistryProfile | null };

/** One row for each chain given, in the order given. The caller passes only the chains whose switch is on. */
export function buildExtraChainStats(input: ChainStatsInput, chains: readonly ExtraChainKey[], profiles: Partial<Record<ExtraChainKey, RegistryProfile | null>> = {}): ExtraChainStat[] {
  return chains.map(chain => ({ chain, ...statFor(chain, input), registry: profiles[chain] ?? null }));
}
