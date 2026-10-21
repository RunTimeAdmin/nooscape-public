import { EXTRA_CHAINS, EXTRA_CHAIN_LABEL, extraProtocolOf } from "@shared/chains";

/**
 * How the public directory counts and names its protocols. The registry-backed
 * protocols are chain facts. The BNB Chain ERC-8004 registry is a chain fact
 * too, but the directory lists only the registrations that pass the published
 * rules (a few thousand of the 373k on-chain), so it is counted on its own,
 * beside its registry profile, instead of being blended into the registry
 * headline. Everything else is a locator listing seen on a directory or card
 * endpoint. Ethereum, Base and Arc are read the way BNB Chain is, and are counted
 * the same way: on their own, while their switch is on, and never as locator listings.
 */
export const ON_CHAIN_REGISTRY_PROTOCOLS = ["erc8004", "solana_registry", "solana_8004", "solana_said"] as const;
export const BNB_CHAIN_PROTOCOL = "erc8004_bsc";

type ProtocolCount = { protocol: string; count: number };

/** The protocols of Ethereum, Base and Arc. A chain whose switch is off has no entry in the directory reads, so it adds nothing here. */
const EXTRA_CHAIN_PROTOCOLS = EXTRA_CHAINS.map(extraProtocolOf);

/**
 * Splits the acknowledged total three ways that never overlap: registry-backed
 * identities, listed BNB Chain registrations, and locator listings (the
 * remainder). A BNB Chain row is never counted as a locator listing, and the
 * registry headline stays the figure it was before BNB Chain was approved. The
 * listed registrations of Ethereum, Base and Arc are not locator listings
 * either: they leave the remainder, and {@link extraChainTotals} counts them.
 */
export function splitDirectoryTotals(byProtocol: readonly ProtocolCount[], total: number) {
  const count = (protocols: readonly string[]) => byProtocol.filter(entry => protocols.includes(entry.protocol)).reduce((sum, entry) => sum + entry.count, 0);
  const onChain = count(ON_CHAIN_REGISTRY_PROTOCOLS);
  const bnbChain = count([BNB_CHAIN_PROTOCOL]);
  return { onChain, bnbChain, locator: Math.max(0, total - onChain - bnbChain - count(EXTRA_CHAIN_PROTOCOLS)) };
}

/** The listed registrations of each of Ethereum, Base and Arc that has any, in tab order. Empty while all three are off. */
export function extraChainTotals(byProtocol: readonly ProtocolCount[]): Array<{ chain: (typeof EXTRA_CHAINS)[number]; label: string; count: number }> {
  return EXTRA_CHAINS.flatMap(chain => {
    const count = byProtocol.filter(entry => entry.protocol === extraProtocolOf(chain)).reduce((sum, entry) => sum + entry.count, 0);
    return count > 0 ? [{ chain, label: EXTRA_CHAIN_LABEL[chain], count }] : [];
  });
}

/**
 * The EVM identity registries are one contract deployed on several chains, so a
 * bare "ERC8004" says nothing about which one it is. Each is named by its chain
 * everywhere a protocol is shown.
 */
const CHAIN_LABELS: Record<string, string> = {
  erc8004: "ERC-8004 · ROBINHOOD CHAIN",
  [BNB_CHAIN_PROTOCOL]: "ERC-8004 · BNB CHAIN",
  ...Object.fromEntries(EXTRA_CHAINS.map(chain => [extraProtocolOf(chain), `ERC-8004 · ${EXTRA_CHAIN_LABEL[chain].toUpperCase()}`])),
};

/** The display name of a directory protocol; the EVM registries say which chain they are on. */
export function directoryProtocolLabel(protocol: string): string {
  return CHAIN_LABELS[protocol] ?? protocol.replace(/_/g, " ").toUpperCase();
}

/**
 * What a search hit prints for its protocol: the chain-labeled name for the EVM
 * registries, and the protocol exactly as recorded for every other one.
 */
export function directoryProtocolDisplay(protocol: string): string {
  return CHAIN_LABELS[protocol] ?? protocol;
}

/**
 * Counts the reviewed records by the protocol each one is shown under: its
 * Solana registry when it has one (the Metaplex registry first, then the 8004
 * registry), otherwise its first protocol, and A2A when it records none. One
 * protocol per record, so the counts add up to the number of reviewed records.
 */
export function reviewedProtocolCounts(protocolLists: string[][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const protocols of protocolLists) {
    const protocol = protocols.includes("solana_registry") ? "solana_registry" : protocols.includes("solana_8004") ? "solana_8004" : protocols[0] ?? "a2a";
    counts[protocol] = (counts[protocol] ?? 0) + 1;
  }
  return counts;
}

/** One protocol in the population list: everything acknowledged under it, and how many of its records are reviewed. */
export type ProtocolPopulationRow = {
  protocol: string;
  label: string;
  /** Null for a protocol the directory does not acknowledge (A2A cards are reviewed records only). */
  acknowledged: number | null;
  reviewed: number;
};

/**
 * Every protocol Nooscape reads, from the directory's acknowledged counts and
 * the reviewed records: largest acknowledged count first, protocols with only
 * reviewed records after them. A protocol with no reviewed record says so with a
 * zero rather than being left out.
 */
export function buildProtocolPopulation(byProtocol: readonly ProtocolCount[], reviewedByProtocol: Record<string, number>): ProtocolPopulationRow[] {
  const protocols = Array.from(new Set([...byProtocol.map(entry => entry.protocol), ...Object.keys(reviewedByProtocol)]));
  return protocols
    .map(protocol => ({
      protocol,
      label: directoryProtocolLabel(protocol),
      acknowledged: byProtocol.find(entry => entry.protocol === protocol)?.count ?? null,
      reviewed: reviewedByProtocol[protocol] ?? 0,
    }))
    .sort((left, right) => (right.acknowledged ?? -1) - (left.acknowledged ?? -1) || right.reviewed - left.reviewed || left.label.localeCompare(right.label));
}

/**
 * The listing rules in words, built from the thresholds the server publishes so
 * the page can never disagree with the rule it describes.
 */
export function listingRulesSentence(rules: { sharedProfileLinkFrom: number; sharedHostFrom: number; sharedWalletFrom: number }): string {
  const link =
    rules.sharedProfileLinkFrom === 2
      ? "a profile link no other registration holds"
      : `a profile link held by fewer than ${rules.sharedProfileLinkFrom.toLocaleString()} registrations`;
  return `Listed means ${link}, a host fewer than ${rules.sharedHostFrom.toLocaleString()} registrations point at, a wallet that registered fewer than ${rules.sharedWalletFrom.toLocaleString()} agents, and a name that is not only a number`;
}

/**
 * The chains whose registry the chain pass reads, by the name a sentence uses: BNB Chain, and Ethereum, Base and Arc. These
 * count the registrations of a wallet or a host over the whole registry, listed or not. Null for every other protocol.
 */
export function registryChainName(protocol: string): string | null {
  if (protocol === BNB_CHAIN_PROTOCOL) return "BNB Chain";
  const extra = EXTRA_CHAINS.find(chain => extraProtocolOf(chain) === protocol);
  return extra ? EXTRA_CHAIN_LABEL[extra] : null;
}

/**
 * One look-alike sentence. Counts for a directory entry are other directory
 * entries. A chain-pass registry (BNB Chain, Ethereum, Base, Arc) counts the
 * registrations of a wallet or a host over the whole registry, listed or not,
 * and the sentence says so, because most of those registrations are held out
 * of the listing.
 */
export function lookalikeLine(protocol: string, count: number, shared: string): string {
  const total = count.toLocaleString();
  const chain = registryChainName(protocol);
  if (chain) {
    return `${total} other ${count === 1 ? `registration on ${chain} shares` : `registrations on ${chain} share`} this ${shared} (counted over the whole registry, listed or not).`;
  }
  return `${total} other ${count === 1 ? "entry shares" : "entries share"} this ${shared}.`;
}
