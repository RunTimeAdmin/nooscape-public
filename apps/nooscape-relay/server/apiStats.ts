import type { Arrivals } from "@shared/arrivals";
import { listedChainLabel, type ChainStat, type ExtraChainStat } from "@shared/chains";
import { API_CHAINS, type ApiChain } from "./apiChains";
import { API_LICENSE } from "./apiLicense";

/**
 * What the directory holds on each chain, for GET /api/v1/stats. Every figure is one the site's own chain tabs show, read through the
 * same public procedures (`liveData.chainStats`, `arrivals` and `directoryBscRegistry`), so the API cannot count differently from the
 * site: entries under the public rules, a chain Nooscape does not read is "not indexed" and not zero, and a count that cannot be read
 * is null and not a guess. Nothing here ranks a chain, a registry or an agent, and no figure says an agent is good or bad.
 */

/** What the answer is built from: the site's own chain figures and arrivals, read together. */
export type StatsRead = {
  /** When the answer was built (ISO 8601). The counts behind it are kept by the site's reads for up to five minutes. */
  readAt: string;
  chains: ChainStat[];
  extras: ExtraChainStat[];
  /** What entered the directory in the last day, or null where that count could not be read. */
  arrivals: Arrivals | null;
  /** The registrations the BNB Chain registry holds, where its registry has been read. */
  bnbRegistrations: number | null;
};

/** The three public procedures the figures come from, as the site's own pages call them. */
export type StatsFeeds = {
  chainStats: () => Promise<{ chains: ChainStat[]; extras?: ExtraChainStat[] }>;
  arrivals: () => Promise<{ arrivals: Arrivals | null }>;
  bnbRegistry: () => Promise<{ profile: { recorded: number } | null }>;
};

/**
 * Reads the figures once. The site's chain read answers no chains when it could not read them, which is a failure to read and not a
 * directory with nothing in it, so it is thrown and never kept. A missing arrivals count or BNB registry count leaves that one figure
 * null; it does not fail the answer.
 */
export async function readStats(feeds: StatsFeeds, now: () => Date = () => new Date()): Promise<StatsRead> {
  const [stats, arrived, bnb] = await Promise.all([feeds.chainStats(), feeds.arrivals(), feeds.bnbRegistry()]);
  if (stats.chains.length === 0) throw new Error("The chain figures could not be read.");
  return { readAt: now().toISOString(), chains: stats.chains, extras: stats.extras ?? [], arrivals: arrived.arrivals, bnbRegistrations: bnb.profile?.recorded ?? null };
}

export const STATS_STATEMENT =
  "Counts of what the directory holds on each chain it reads, and when each chain was last read. A count of listed entries is not a count of the agents that exist or work, and a registration that the published listing rules do not list is held out and not judged.";

/** One answer for the chains the API serves, in the order it serves them. A served chain with no figures is reported as not indexed. */
export function statsAnswer(read: StatsRead, served: readonly ApiChain[]) {
  const chains = served.map(chain => {
    const table = API_CHAINS[chain];
    const row: ChainStat | ExtraChainStat | undefined = read.extras.find(item => item.chain === chain) ?? read.chains.find(item => item.chain === chain);
    const arrival = read.arrivals?.chains.find(item => item.chain === chain);
    // A registry's own count is kept apart from the entries listed only for BNB Chain, Base, Arc and Ethereum, whose listing rules hold some out.
    const registrations = chain === "bnb" ? read.bnbRegistrations : row && "registry" in row ? (row.registry?.recorded ?? null) : null;
    return {
      chain,
      label: listedChainLabel(chain),
      chain_id: table.chainId,
      indexed: row?.indexed ?? false,
      acknowledged: row?.acknowledged ?? null,
      ratings_recorded: row?.feedbackEvents ?? null,
      registrations_on_chain: registrations,
      new_in_24h: arrival?.added ?? null,
      registries: (row?.registries ?? []).map(registry => ({ registry: registry.protocol, address: table.registry, acknowledged: registry.count })),
      last_read_at: row?.asOf ?? null,
    };
  });
  return {
    api_version: "v1" as const,
    as_of: read.readAt,
    source: { kind: "directory_stats" as const, chains: [...served] },
    license: API_LICENSE,
    data: {
      statement: STATS_STATEMENT,
      totals: { acknowledged: chains.reduce((sum, chain) => sum + (chain.acknowledged ?? 0), 0) },
      chains,
    },
  };
}

export type StatsAnswer = ReturnType<typeof statsAnswer>;
