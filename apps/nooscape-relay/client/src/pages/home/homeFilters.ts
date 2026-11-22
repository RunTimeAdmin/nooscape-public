import { PUBLISHER_STATES, type PublisherState } from "@/lib/evidenceReadout";
import type { TrustFilter } from "./atlasModel";

/**
 * The home page's filters, kept in the address so a refresh, a shared link or the Back button brings them back. Only a filter that is
 * not at its default is written, so the plain address stays plain, and every value read from an address is checked: one that is not a
 * value the page offers is read as the default.
 *
 * Address keys: q (the search), protocol, evidence (an evidence group), sort, trusted (1), state (a publisher state).
 */
export const ALL_PROTOCOLS = "All protocols";
export const SORT_MODES = ["network", "evidence", "name"] as const;
export type SortMode = (typeof SORT_MODES)[number];
const TRUST_FILTERS: readonly TrustFilter[] = ["all", "owner", "website", "none"];

export type HomeFilters = {
  query: string;
  framework: string;
  evidence: TrustFilter;
  sort: SortMode;
  trustedOnly: boolean;
  publisherState: PublisherState | "all";
};

export const DEFAULT_FILTERS: HomeFilters = { query: "", framework: ALL_PROTOCOLS, evidence: "all", sort: "network", trustedOnly: false, publisherState: "all" };

/** Longest search or protocol name kept from an address. */
const MAX_TEXT = 80;

const oneOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T => (values as readonly string[]).includes(value ?? "") ? (value as T) : fallback;

export function filtersFromSearch(search: string): HomeFilters {
  const params = new URLSearchParams(search);
  const text = (key: string) => (params.get(key) ?? "").slice(0, MAX_TEXT);
  return {
    query: text("q"),
    framework: text("protocol").trim() || ALL_PROTOCOLS,
    evidence: oneOf(TRUST_FILTERS, params.get("evidence"), "all"),
    sort: oneOf(SORT_MODES, params.get("sort"), "network"),
    trustedOnly: params.get("trusted") === "1",
    publisherState: oneOf<PublisherState | "all">(["all", ...PUBLISHER_STATES], params.get("state"), "all"),
  };
}

/** A part's key, decoded. A malformed part is not one of ours: it is kept as it came. */
function keyOf(part: string): string {
  try {
    return decodeURIComponent(part.split("=")[0]!.replace(/\+/g, " "));
  } catch {
    return part;
  }
}

const partsOf = (search: string) => search.replace(/^\?/, "").split("&").filter(part => part !== "");

/** The address without one key, every other part kept as it was written. */
export function searchWithout(search: string, key: string): string {
  const kept = partsOf(search).filter(part => keyOf(part) !== key);
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/** Our keys, in the order they are written. */
const KEYS = ["q", "protocol", "evidence", "sort", "trusted", "state"] as const;

/**
 * The address with these filters in it. Every other part of it (the agent, a comparison, the hash) is kept as it was written, byte for
 * byte: re-encoding it would turn a comparison's "a~b" into "a%7Eb".
 */
export function searchWithFilters(search: string, filters: HomeFilters): string {
  const ours = new Set<string>(KEYS);
  const kept = partsOf(search).filter(part => !ours.has(keyOf(part)));
  const values: Record<(typeof KEYS)[number], string | null> = {
    q: filters.query.trim() === "" ? null : filters.query,
    protocol: filters.framework === ALL_PROTOCOLS ? null : filters.framework,
    evidence: filters.evidence === "all" ? null : filters.evidence,
    sort: filters.sort === "network" ? null : filters.sort,
    trusted: filters.trustedOnly ? "1" : null,
    state: filters.publisherState === "all" ? null : filters.publisherState,
  };
  const written = KEYS.filter(key => values[key] !== null).map(key => new URLSearchParams({ [key]: values[key]! }).toString());
  const all = [...kept, ...written];
  return all.length > 0 ? `?${all.join("&")}` : "";
}

/** A protocol filter the records no longer have would show an empty map with nothing saying why: it falls back to all protocols. */
export function liveFramework(framework: string, frameworks: readonly string[], loaded: boolean): string {
  return !loaded || framework === ALL_PROTOCOLS || frameworks.includes(framework) ? framework : ALL_PROTOCOLS;
}
