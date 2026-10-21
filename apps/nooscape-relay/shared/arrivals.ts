import { CHAINS, listedChainOf, type ExtraChainKey, type ListedChainKey } from "./chains";

/**
 * What entered the directory in the last day, per chain: the figures behind the Home page's "new to the Owl" lines.
 * A count here is the number of visible directory entries whose own first-seen time falls inside the window, the
 * same rows every other public count reads. It says when the Owl first saw an entry, not when the agent was made.
 * Pure and shared, so the server that builds it and the page that words it agree.
 */
export const ARRIVALS_WINDOW_HOURS = 24;
/** How many of a chain's newest entries the page names. */
export const ARRIVALS_NEWEST_PER_CHAIN = 3;

export type ArrivedEntry = { id: string; displayName: string; firstSeenAt: string };

export type ChainArrivals = {
  chain: ListedChainKey;
  /** At least one approved, active source for this chain. A chain with none is not measured, not zero. */
  indexed: boolean;
  /** Visible entries first seen in the window; null while the chain is not indexed. */
  added: number | null;
  /** The newest of them, newest first, at most {@link ARRIVALS_NEWEST_PER_CHAIN}. */
  newest: ArrivedEntry[];
  /** How many of the window's entries each registry on the chain added, largest first; registries with none are left out. */
  registries: Array<{ protocol: string; count: number }>;
};

export type Arrivals = {
  windowHours: number;
  /** When the figures were counted (ISO 8601), so the page says when they are from and never uses its own clock. */
  computedAt: string;
  chains: ChainArrivals[];
};

export type ArrivalsInput = {
  now: Date;
  /** Visible entries first seen in the window, by protocol. */
  counts: ReadonlyArray<{ protocol: string; count: number }>;
  /** The newest entries in the window on each chain, newest first (the reader limits each chain's list). */
  newest: ReadonlyArray<{ chain: ListedChainKey; id: string; displayName: string; firstSeenAt: Date | string }>;
  /** The protocols of the sources that are active. */
  activeProtocols: ReadonlyArray<string>;
  /** The extra chains whose switch is on (`extraChainsOn`): each gets a row after the original three. None when left out. */
  extras?: readonly ExtraChainKey[];
};

const toIso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/** One row per chain, in the order of {@link CHAINS}, then one for each extra chain that is on. */
export function buildArrivals(input: ArrivalsInput): Arrivals {
  const chains: ListedChainKey[] = [...CHAINS, ...(input.extras ?? [])];
  return {
    windowHours: ARRIVALS_WINDOW_HOURS,
    computedAt: input.now.toISOString(),
    chains: chains.map(chain => {
      const indexed = input.activeProtocols.some(protocol => listedChainOf(protocol) === chain);
      const added = input.counts.filter(row => listedChainOf(row.protocol) === chain).reduce((sum, row) => sum + row.count, 0);
      const newest = input.newest
        .filter(row => row.chain === chain)
        .slice(0, ARRIVALS_NEWEST_PER_CHAIN)
        .map(row => ({ id: row.id, displayName: row.displayName, firstSeenAt: toIso(row.firstSeenAt) }));
      const registries = input.counts
        .filter(row => listedChainOf(row.protocol) === chain && row.count > 0)
        .map(row => ({ protocol: row.protocol, count: row.count }))
        .sort((left, right) => right.count - left.count);
      return { chain, indexed, added: indexed ? added : null, newest: indexed ? newest : [], registries: indexed ? registries : [] };
    }),
  };
}
