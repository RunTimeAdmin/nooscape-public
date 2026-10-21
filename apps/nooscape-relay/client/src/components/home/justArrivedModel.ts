import type { Arrivals, ChainArrivals } from "@shared/arrivals";
import { extraChainsOn, type ListedChainKey } from "@shared/chains";
import { formatAsOf, REGION_ORDER } from "./chainTabsModel";

/**
 * The words around the "new to the Owl" figures, decided from the server's read. Pure, so the three states of a chain
 * (counted, not indexed, nothing new) and the line in the hero are tested without a browser. Every figure is the
 * server's, and a chain the server does not measure is never worded as a zero.
 */

/**
 * The chains the section draws: the three it always draws, then each extra chain (Arc, for now) that is on in this build and that the
 * server sent a row for. A switch that is on in the build and off on the server draws nothing for that chain.
 */
export function arrivedRegions(arrivals: Arrivals | null, features: string | undefined): ListedChainKey[] {
  const sent = new Set<string>(arrivals?.chains.map(row => row.chain) ?? []);
  return [...REGION_ORDER, ...extraChainsOn(features).filter(chain => sent.has(chain))];
}

/** The grid's columns for that many chain cards: three across as it has always been, and four across when there are four. */
export function arrivedGridClass(count: number): string {
  if (count <= 3) return "sm:grid-cols-3";
  return count === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";
}

/** What a chain's count says, or null when the chain is not measured. */
export function arrivedCountText(row: Pick<ChainArrivals, "indexed" | "added">): string | null {
  if (!row.indexed || row.added === null) return null;
  if (row.added === 0) return "nothing new";
  return row.added === 1 ? "new entry" : "new entries";
}

/** The chains that are measured, so a total is never a sum over a chain nobody reads. */
export function measuredChains(arrivals: Arrivals): ChainArrivals[] {
  return arrivals.chains.filter(row => row.indexed && row.added !== null);
}

/** The count across the measured chains, or null when none is measured. */
export function arrivedTotal(arrivals: Arrivals | null): number | null {
  if (!arrivals) return null;
  const measured = measuredChains(arrivals);
  return measured.length === 0 ? null : measured.reduce((sum, row) => sum + (row.added ?? 0), 0);
}

/** The line under the hero's figures, or null when there is nothing true to say. */
export function arrivedHeroLine(arrivals: Arrivals | null): string | null {
  const total = arrivedTotal(arrivals);
  if (total === null || !arrivals) return null;
  if (total === 0) return `The Owl saw nothing new in the last ${arrivals.windowHours} hours.`;
  return `The Owl first saw ${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"} in the last ${arrivals.windowHours} hours.`;
}

/** When the figures were counted, in the server's time and UTC, or null when it cannot be read. */
export function arrivedCountedAt(arrivals: Arrivals): string | null {
  const when = formatAsOf(arrivals.computedAt);
  return when ? `Counted ${when}, from each entry's own first-seen time, under the same public rules as every other count.` : null;
}

/** When the Owl first saw an entry, for the line under its name. */
export function firstSeenText(iso: string): string | null {
  const when = formatAsOf(iso);
  return when ? `first seen ${when}` : null;
}
