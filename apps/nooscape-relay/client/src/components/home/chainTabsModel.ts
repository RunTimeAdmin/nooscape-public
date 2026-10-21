import { extraChainsOn, type ChainKey, type ChainStat, type ExtraChainKey, type ExtraChainStat, type ListedChainKey } from "@shared/chains";
import { CHAIN_STYLE, markerPath, type MarkerShape } from "./constellationModel";

/**
 * What a chain tab shows, decided from the server's row for that chain. Pure, so the
 * wording around the three states (a chain with figures, one that is not indexed, and
 * one whose figures cannot be read) is tested without a browser.
 */
export type TabState = "ready" | "not-indexed" | "unavailable";

export function tabState(row: Pick<ChainStat, "indexed"> | undefined): TabState {
  if (!row) return "unavailable";
  return row.indexed ? "ready" : "not-indexed";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct 2026, 15:30 UTC" from an ISO timestamp, in UTC whatever the visitor's zone, or null when there is none to show. */
export function formatAsOf(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/** The sentence under the figures that says how fresh they are. */
export function asOfSentence(iso: string | null): string {
  const text = formatAsOf(iso);
  return text ? `Last successful read of this chain: ${text}.` : "No successful read of this chain has been recorded yet.";
}

/** The BNB Chain registry's recorded facts, as the one sentence the tab adds: what is on the chain, and how much of it the directory lists. */
export function bnbSentence(profile: { recorded: number; listed: number } | null): string | null {
  if (!profile || profile.recorded <= 0) return null;
  return `The chain holds ${profile.recorded.toLocaleString()} registrations. The published listing rules put ${profile.listed.toLocaleString()} of them in the directory; the rest are held out, not judged.`;
}

/** The same sentence for every registry the chain pass reads: BNB Chain, and Ethereum, Base and Arc beside it. */
export const registrySentence = bnbSentence;

/**
 * What the "Ratings recorded" figure counts on each chain. Robinhood Chain's is the reputation ledger. Solana's is the 8004
 * registry's own feedback counters, summed, and the note says the other two registries keep none Nooscape reads, so the
 * figure is never taken for all of Solana. BNB Chain's is not measured here.
 */
export function ratingsNote(chain: ListedChainKey): string {
  if (chain === "solana") return "The 8004 registry's own feedback counters, summed. SAID and Metaplex keep no ratings Nooscape reads. Not a score.";
  return "Ratings written on-chain, revoked ones included. Not a score.";
}

/**
 * The Solana registries by name. Robinhood Chain and BNB Chain each have one registry, which the chain's name already says,
 * so only Solana's carry a label here and the split is only ever worded for Solana.
 */
const REGISTRY_LABEL = new Map([["solana_said", "SAID"], ["solana_8004", "8004"], ["solana_registry", "Metaplex"]]);

/** "By registry: SAID 13,764 · Metaplex 1,596 · 8004 1,506." in the order given, or null when none of the registries is a named one. */
export function registrySplitText(registries: ReadonlyArray<{ protocol: string; count: number }>): string | null {
  const named = registries.flatMap(registry => {
    const label = REGISTRY_LABEL.get(registry.protocol);
    return label ? [`${label} ${registry.count.toLocaleString("en-US")}`] : [];
  });
  return named.length === 0 ? null : `By registry: ${named.join(" · ")}.`;
}

/** The regions in the order the brief names them: Robinhood, BNB, Solana. The tabs and the heading follow it; the scan map's key keeps the order the map itself uses. */
export const REGION_ORDER: readonly ChainKey[] = ["robinhood", "bnb", "solana"];

/**
 * The regions the tabs show: the three above, then each extra chain (Ethereum, Base, Arc) that is switched on in this build. Once the
 * server has answered, an extra chain it sent no row for is left out too, so a switch that is on in the build and off on the server
 * shows nothing. `extras` is null until the answer is in, and the list is then the one the build asks for, so the heading does not
 * change when the figures arrive.
 */
export function regionsShown(extras: readonly Pick<ExtraChainStat, "chain">[] | null, features: string | undefined): ListedChainKey[] {
  const planned = extraChainsOn(features);
  return [...REGION_ORDER, ...planned.filter(chain => extras === null || extras.some(row => row.chain === chain))];
}

const REGION_NAME: Record<ListedChainKey, string> = { robinhood: "Robinhood", bnb: "BNB", solana: "Solana", ethereum: "Ethereum", base: "Base", arc: "Arc" };
const SKY_COUNT = ["no", "one", "two", "three", "four", "five", "six"];

/** The heading over the tabs: the regions by name, in order. With the original three it is the sentence the page has always had. */
export function regionsHeading(regions: readonly ListedChainKey[]): string {
  return `${regions.map(region => REGION_NAME[region]).join(", ")}. Same Owl, ${SKY_COUNT[regions.length] ?? String(regions.length)} skies.`;
}

type RegionShape = MarkerShape | "pentagon" | "cross" | "dome";

/**
 * The icons of the extra chains. They have no lights on the map, so these are not the map key's shapes: each is its own, drawn in the
 * tab's -1.5 to 1.5 box, so the name and the shape both say which region a tab is and colour is never the only signal.
 */
const EXTRA_ICON: Record<ExtraChainKey, { shape: RegionShape; path: string }> = {
  ethereum: { shape: "pentagon", path: "M0 -1.25L1.19 -0.39L0.73 1.01L-0.73 1.01L-1.19 -0.39Z" },
  base: { shape: "cross", path: "M-0.4 -1.2H0.4V-0.4H1.2V0.4H0.4V1.2H-0.4V0.4H-1.2V-0.4H-0.4Z" },
  arc: { shape: "dome", path: "M-1.2 0.9A1.2 1.2 0 0 1 1.2 0.9Z" },
};

/** A region's icon: the same shape its lights have on the map for the original three, so a tab reads like the map's key and colour is never the only way to tell the regions apart. */
export function regionIcon(chain: ListedChainKey): { shape: RegionShape; path: string } {
  if (chain === "ethereum" || chain === "base" || chain === "arc") return EXTRA_ICON[chain];
  const { shape } = CHAIN_STYLE[chain];
  return { shape, path: markerPath(shape) };
}

/** The CSS variable (index.css) that holds a chain's colour. A colour is only ever a second signal: the tab also carries the chain's name. */
export function chainColorVar(chain: ListedChainKey): string {
  return `--ns-chain-${chain}`;
}
