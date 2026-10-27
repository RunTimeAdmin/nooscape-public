/**
 * The Owl's Catch: one factual finding a day, chosen by a fixed rule from the directory's own counts and stored
 * with the values it was made from, so it can be shown again as it was found. Pure and shared: the server that
 * chooses and stores it and the page that shows it agree on the rules and the words.
 *
 * Nothing here is a verdict. A catch says what a count is ("one registering wallet is recorded against N
 * identities"), never what it means; its words are built only from the stored facts, so every figure in a
 * headline is a value the database gave and nothing is added to it.
 */
import { CHAINS, EXTRA_CHAINS, extraChainsOn, listedChainLabel, type ChainStat, type ExtraChainKey, type ExtraChainStat, type ListedChainKey } from "./chains";
import { FLEET_MIN } from "./noosphere";

const CATCH_RULES = ["fleet", "milestone"] as const;
type CatchRule = (typeof CATCH_RULES)[number];
/** A day with nothing to report is stored too, so the day is decided once and never again. */
export const NO_CATCH = "none";
export type StoredRule = CatchRule | typeof NO_CATCH;

/** A wallet that has been featured is left alone for this many days, so the catch is a different fleet each time. */
export const NOVELTY_DAYS = 30;
/** How many wallets the selection reads, largest first. */
export const WALLETS_READ = 40;
/** How many of a fleet's identities are stored with its catch. */
export const MAX_AGENT_IDS = 20;
/** A milestone is recent while the count is under this multiple of it. */
const MILESTONE_WINDOW = 1.25;

export type FleetFacts = { registrant: string; agentCount: number; dominantHost: string | null };
type MilestoneMetric = "reviewed" | "acknowledged";
export type MilestoneFacts = { chain: ListedChainKey; metric: MilestoneMetric; milestone: number; value: number; asOf: string | null };

export type Choice =
  | { rule: "fleet"; facts: FleetFacts; sourceQuery: string }
  | { rule: "milestone"; facts: MilestoneFacts; sourceQuery: string };

/** What an earlier day's catch holds, enough to know what has been featured. */
export type PastCatch = { date: string; rule: StoredRule; facts: unknown };

export type WalletInput = { registrant: string | null; agentCount: number; dominantHost: string | null };

export const FLEET_SOURCE_QUERY = "directory entries grouped by registering wallet, visible entries only, largest first (the read behind Fleet sightings)";
export const MILESTONE_SOURCE_QUERY = "the per-chain counts behind Regions (liveData.chainStats)";
export const NO_RULE_MATCHED = "no rule matched the day's counts";

const METRICS: readonly MilestoneMetric[] = ["reviewed", "acknowledged"];
/** The chains a milestone can be about: the original three, then the extra chains. An extra chain has a milestone only when the caller gives its row, which is while its switch is on. */
const MILESTONE_CHAINS: readonly ListedChainKey[] = [...CHAINS, ...EXTRA_CHAINS];
const isExtraChain = (chain: ListedChainKey): chain is ExtraChainKey => EXTRA_CHAINS.some(candidate => candidate === chain);
const METRIC_LABEL: Record<MilestoneMetric, string> = { reviewed: "reviewed records", acknowledged: "acknowledged entries" };

// ----------------------------------------------------------------------------------------------- numbers

/** 10, 25, 50, 100, 250, 500, 1,000 and so on: one, two and a half and five times each power of ten. */
const LADDER: readonly number[] = Array.from({ length: 7 }, (_, power) => [1, 2.5, 5].map(step => step * 10 ** (power + 1))).flat();

/** The largest round number the count has reached, or null under ten. */
export function milestoneFor(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  let reached: number | null = null;
  for (const step of LADDER) if (value >= step) reached = step;
  return reached;
}

/** The round number the count has only just passed, or null when it passed it a while ago. */
export function recentMilestone(value: number): number | null {
  const milestone = milestoneFor(value);
  return milestone !== null && value < milestone * MILESTONE_WINDOW ? milestone : null;
}

export const formatCount = (value: number) => value.toLocaleString("en-US");

/** A wallet or key shortened for a line of text: the start and end are enough to tell wallets apart. */
export function shortWallet(address: string): string {
  if (address.length <= 14) return address;
  const head = address.startsWith("0x") ? 6 : 4;
  return `${address.slice(0, head)}…${address.slice(-4)}`;
}

/** UTC calendar date as YYYY-MM-DD. */
export const utcDate = (when: Date) => when.toISOString().slice(0, 10);
export const isCatchDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && utcDate(new Date(`${value}T00:00:00Z`)) === value;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-10-15" as "15 Oct 2026". Anything that is not a plain date is returned as it came. */
export function dateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : date;
}

/** Whole days from one date to a later one. */
export function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

// ----------------------------------------------------------------------------------------------- facts

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parseFleetFacts(value: unknown): FleetFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Record<string, unknown>;
  if (!isText(facts.registrant) || !isCount(facts.agentCount)) return null;
  if (facts.dominantHost !== null && !isText(facts.dominantHost)) return null;
  return { registrant: facts.registrant, agentCount: facts.agentCount, dominantHost: facts.dominantHost ?? null };
}

function parseMilestoneFacts(value: unknown): MilestoneFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Record<string, unknown>;
  const chain = MILESTONE_CHAINS.find(candidate => candidate === facts.chain);
  const metric = METRICS.find(candidate => candidate === facts.metric);
  if (!chain || !metric || !isCount(facts.milestone) || !isCount(facts.value)) return null;
  if (facts.asOf !== null && typeof facts.asOf !== "string") return null;
  return { chain, metric, milestone: facts.milestone, value: facts.value, asOf: (facts.asOf as string | null) ?? null };
}

/** The facts as the database stores them (JSON text), checked, or null for text that does not hold a valid set of facts. */
export function parseFacts(rule: StoredRule, text: string): FleetFacts | MilestoneFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return rule === "fleet" ? parseFleetFacts(value) : rule === "milestone" ? parseMilestoneFacts(value) : null;
}

/** The identity ids as the database stores them (JSON text), or an empty list for text that is not a list of ids. */
export function parseAgentIds(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter(isText).slice(0, MAX_AGENT_IDS) : [];
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------------------------- selection

/** The wallets that may be featured today, largest first: a real fleet, and not one featured in the last month. */
export function eligibleFleets(wallets: readonly WalletInput[], past: readonly PastCatch[], date: string): FleetFacts[] {
  const recently = new Set<string>();
  for (const earlier of past) {
    if (earlier.rule !== "fleet" || daysBetween(earlier.date, date) >= NOVELTY_DAYS) continue;
    const facts = parseFleetFacts(earlier.facts);
    if (facts) recently.add(facts.registrant);
  }
  return wallets
    .flatMap(wallet => {
      const facts = parseFleetFacts({ registrant: wallet.registrant, agentCount: wallet.agentCount, dominantHost: wallet.dominantHost });
      return facts && facts.agentCount >= FLEET_MIN && !recently.has(facts.registrant) ? [facts] : [];
    })
    .sort((a, b) => b.agentCount - a.agentCount || (a.registrant < b.registrant ? -1 : 1));
}

/** The round numbers a chain's counts have just passed and the catch has not yet said. An extra chain is looked at only if the caller gives its row. */
export function newMilestones(chains: readonly (ChainStat | ExtraChainStat)[], past: readonly PastCatch[]): MilestoneFacts[] {
  const said = new Map<string, number>();
  for (const earlier of past) {
    if (earlier.rule !== "milestone") continue;
    const facts = parseMilestoneFacts(earlier.facts);
    if (facts) said.set(`${facts.chain}:${facts.metric}`, Math.max(said.get(`${facts.chain}:${facts.metric}`) ?? 0, facts.milestone));
  }
  const found: MilestoneFacts[] = [];
  for (const chain of MILESTONE_CHAINS) {
    const stat = chains.find(row => row.chain === chain);
    if (!stat || !stat.indexed) continue;
    for (const metric of METRICS) {
      const value = stat[metric];
      if (!isCount(value)) continue;
      const milestone = recentMilestone(value);
      if (milestone !== null && milestone > (said.get(`${chain}:${metric}`) ?? 0)) found.push({ chain, metric, milestone, value, asOf: stat.asOf });
    }
  }
  return found;
}

/**
 * Today's candidates, in the order they would be chosen: a round number a chain has just passed first, then the
 * largest fleet not featured this month. Chosen by a fixed rule from the day's counts and what has been said
 * before, so the same counts and the same past give the same list.
 */
export function candidateCatches(input: { date: string; wallets: readonly WalletInput[]; chains: readonly (ChainStat | ExtraChainStat)[]; past: readonly PastCatch[] }): Choice[] {
  const milestones: Choice[] = newMilestones(input.chains, input.past).map(facts => ({ rule: "milestone", facts, sourceQuery: MILESTONE_SOURCE_QUERY }));
  const fleets: Choice[] = eligibleFleets(input.wallets, input.past, input.date).map(facts => ({ rule: "fleet", facts, sourceQuery: FLEET_SOURCE_QUERY }));
  return [...milestones, ...fleets];
}

// ----------------------------------------------------------------------------------------------- words

const RULE_TEXT: Record<CatchRule, string> = {
  milestone: "a chain's count that has just passed a round number (one, two and a half or five times a power of ten) that has not been featured yet",
  fleet: `the registering wallet with the most identities, at least ${FLEET_MIN}, that has not been featured in the last ${NOVELTY_DAYS} days`,
};

export function headlineOf(rule: CatchRule, facts: FleetFacts | MilestoneFacts): string {
  if (rule === "fleet") return `One registering wallet is recorded against ${formatCount((facts as FleetFacts).agentCount)} identities.`;
  const milestone = facts as MilestoneFacts;
  return `${listedChainLabel(milestone.chain)} has passed ${formatCount(milestone.milestone)} ${METRIC_LABEL[milestone.metric]}.`;
}

export function detailOf(rule: CatchRule, facts: FleetFacts | MilestoneFacts): string {
  if (rule === "fleet") {
    const fleet = facts as FleetFacts;
    const host = fleet.dominantHost ? ` The most common locator host among them is ${fleet.dominantHost}.` : "";
    return `Wallet ${shortWallet(fleet.registrant)}.${host} A registering wallet shows who registered, not who holds or runs the agents.`;
  }
  const milestone = facts as MilestoneFacts;
  return `The count is ${formatCount(milestone.value)} under the public rules.`;
}

export function howWeKnowOf(rule: CatchRule, facts: FleetFacts | MilestoneFacts, date: string, sourceQuery: string): string {
  const base = `Chosen on ${date} (UTC) by a fixed rule, not by hand. The rule: ${RULE_TEXT[rule]}. Read from: ${sourceQuery}. Counted under the public rules, so nothing hidden, withdrawn or from an unapproved source is in it.`;
  if (rule === "milestone") {
    const milestone = facts as MilestoneFacts;
    return `${base} Last successful read of this chain: ${milestone.asOf ?? "not recorded"}.`;
  }
  return base;
}

// ----------------------------------------------------------------------------------------------- what the API serves

/** A row of the catch table, as the database returns it. */
export type CatchRow = { catchDate: string; rule: string; facts: string; sourceQuery: string; agentIds: string; selectedAt: Date | string };

export type CatchView = {
  date: string;
  rule: CatchRule;
  headline: string;
  detail: string;
  howWeKnow: string;
  /** Up to twenty directory entries of the fleet, in a fixed order; empty for a milestone. */
  agentIds: string[];
  selectedAt: string;
};

/** A directory entry a fleet's catch links to: its id and the name it is recorded under. */
type CatchAgent = { id: string; name: string };

/** What the public reads serve: a catch with the entries it links to by name, and only those the public may see now. */
export type PublicCatch = Omit<CatchView, "agentIds"> & { agents: CatchAgent[] };

const asRule = (value: string): CatchRule | null => CATCH_RULES.find(rule => rule === value) ?? null;

/**
 * What a stored row says, in words made only of its stored facts, or null for a day with no catch, a row that does not hold what its
 * rule needs, or a milestone of an extra chain whose switch is not on in `features` (nothing of a chain that is off is shown).
 */
export function viewOf(row: CatchRow, features: string | undefined = undefined): CatchView | null {
  const rule = asRule(row.rule);
  if (!rule || !isCatchDate(row.catchDate)) return null;
  const facts = parseFacts(rule, row.facts);
  if (!facts) return null;
  if (rule === "milestone") {
    const { chain } = facts as MilestoneFacts;
    if (isExtraChain(chain) && !extraChainsOn(features).includes(chain)) return null;
  }
  const selectedAt = new Date(row.selectedAt);
  return {
    date: row.catchDate,
    rule,
    headline: headlineOf(rule, facts),
    detail: detailOf(rule, facts),
    howWeKnow: howWeKnowOf(rule, facts, row.catchDate, row.sourceQuery),
    agentIds: rule === "fleet" ? parseAgentIds(row.agentIds) : [],
    selectedAt: Number.isNaN(selectedAt.getTime()) ? row.catchDate : selectedAt.toISOString(),
  };
}

// ----------------------------------------------------------------------------------------------- the page around a catch

/** The production address. A link to share and the preview of it point here whichever address the page was read at. */
export const SITE_ORIGIN = "https://nooscape.si";
export const ARCHIVE_PATH = "/catch";
export const catchPath = (date: string) => `${ARCHIVE_PATH}/${date}`;
export const catchUrl = (date: string) => `${SITE_ORIGIN}${catchPath(date)}`;

export const ARCHIVE_TITLE = "The Owl's Catch | Nooscape";
export const dayTitle = (date: string) => `The Owl's Catch, ${dateLabel(date)} | Nooscape`;

/** What the browser tab and a link preview (a post on X, a chat) say about a page. The server writes these into the page's head, so a crawler that runs no script reads them. */
export type PageMeta = {
  title: string;
  heading: string;
  description: string;
  url: string;
  robots: string;
  /** The card a link preview shows, when the page has one of its own: an absolute address and the words that describe it. Without one the shell's own card stays. */
  image?: { url: string; alt: string };
};

const INDEXED = "index, follow, max-image-preview:large";
const NOT_INDEXED = "noindex, follow";
const SIGN_OFF = "One finding a day from Nooscape's public record, picked by a fixed rule; a count, never a score.";

export const archiveMeta = (): PageMeta => ({ title: ARCHIVE_TITLE, heading: "The Owl's Catch", description: SIGN_OFF, url: `${SITE_ORIGIN}${ARCHIVE_PATH}`, robots: INDEXED });

export const dayMeta = (view: Pick<PublicCatch, "date" | "headline">): PageMeta => ({
  title: dayTitle(view.date),
  heading: `The Owl's Catch, ${dateLabel(view.date)}`,
  description: `${view.headline} ${SIGN_OFF}`,
  url: catchUrl(view.date),
  robots: INDEXED,
});

/** A day that is a date but holds no catch: the page says so, and is kept out of search. */
export const noCatchMeta = (date: string): PageMeta => ({
  title: `No catch on ${dateLabel(date)} | Nooscape`,
  heading: `No catch on ${dateLabel(date)}`,
  description: `No catch was chosen for ${dateLabel(date)}.`,
  url: catchUrl(date),
  robots: NOT_INDEXED,
});

/** A path under /catch that is not a date. */
export const notADateMeta = (): PageMeta => ({ title: "That is not a date | Nooscape", heading: "That is not a date", description: "A catch is found by its day, written year, month, day.", url: `${SITE_ORIGIN}${ARCHIVE_PATH}`, robots: NOT_INDEXED });
