import { FLEET_MIN } from "@shared/noosphere";

/**
 * The rater check for the BNB Chain registry (docs/bsc-rater-credibility-2026-10-16.md; check F and gate G4 of
 * AUTO_REVIEW_PLAN.md). Pure: it takes the feedback the reputation registry recorded and the registry facts about the
 * agents and their owners, and says for each rated agent how many raters it has, how many of them are discounted and why,
 * and how many independent ones are left. Nothing here touches the network or the database.
 *
 * What it is for: ratings on this registry are mostly one group of wallets rating many agents with one identical value. A
 * count of ratings, or of raters, would count that group again and again. This counts only raters that are not that group
 * and are not tied to the agent's owner, and it says how many were set aside and why. The result is supporting evidence with
 * its date. It is never a score or a rank, it is not public, and it is never a reason on its own to promote an agent.
 *
 * Every rule below is a plain fact about wallets and events, with a bar that sits in a measured gap (see the doc), and none of
 * them looks at what an agent is called, what it says or what it costs.
 */

/** A rater that rated this many distinct agents or more is concentrated. Measured on 2026-10-16: 36 wallets rated 34 to 1,800 agents each and the next wallet rated 16. */
export const CONCENTRATED_MIN_AGENTS = 20;
/** A rater with at least this many ratings, nearly all of one identical value, is a scripted batch. */
export const UNIFORM_MIN_EVENTS = 5;
/** "Nearly all": this share of its ratings carry the one value. */
export const UNIFORM_MIN_SHARE = 0.9;
/** An agent qualifies with this many independent raters. */
export const MIN_INDEPENDENT_RATERS = 3;
/** An owner with this many registrations is a fleet wallet, the same bar the map's fleets use. */
export const OWNER_FLEET_MIN = FLEET_MIN;

export type FeedbackEvent = {
  kind: "feedback" | "revoked";
  agentId: number;
  /** The rater's wallet, lower case. */
  client: string;
  /** The contract's per-(agent, client) counter, which is how a revocation names the rating it removes. */
  feedbackIndex: number | null;
  valueRaw: string | null;
  valueDecimals: number | null;
  blockNumber: number;
  logIndex: number;
};

/** The ratings that stand: every rating, less the ones a revocation names by agent, client and feedbackIndex. */
export function liveFeedback(events: readonly FeedbackEvent[]): FeedbackEvent[] {
  const revoked = new Set<string>();
  for (const event of events) if (event.kind === "revoked" && event.feedbackIndex !== null) revoked.add(`${event.agentId}:${event.client}:${event.feedbackIndex}`);
  return events.filter(event => event.kind === "feedback" && !(event.feedbackIndex !== null && revoked.has(`${event.agentId}:${event.client}:${event.feedbackIndex}`)));
}

type RaterStats = {
  client: string;
  events: number;
  /** Distinct agents the rater rated. */
  agents: number;
  /** The share of its ratings that carry its most common (value, decimals), 0 to 1. */
  topValueShare: number;
  topValue: string | null;
};

const valueKey = (event: Pick<FeedbackEvent, "valueRaw" | "valueDecimals">) => `${event.valueRaw ?? ""}/${event.valueDecimals ?? ""}`;

/** What each rater did across all its ratings. */
export function raterStats(feedback: readonly FeedbackEvent[]): Map<string, RaterStats> {
  const byClient = new Map<string, { events: number; agents: Set<number>; values: Map<string, number> }>();
  for (const event of feedback) {
    let entry = byClient.get(event.client);
    if (!entry) {
      entry = { events: 0, agents: new Set(), values: new Map() };
      byClient.set(event.client, entry);
    }
    entry.events += 1;
    entry.agents.add(event.agentId);
    const key = valueKey(event);
    entry.values.set(key, (entry.values.get(key) ?? 0) + 1);
  }
  const stats = new Map<string, RaterStats>();
  byClient.forEach((entry, client) => {
    let topValue: string | null = null;
    let top = 0;
    entry.values.forEach((count, key) => {
      if (count > top || (count === top && topValue !== null && key < topValue)) {
        top = count;
        topValue = key;
      }
    });
    stats.set(client, { client, events: entry.events, agents: entry.agents.size, topValueShare: entry.events === 0 ? 0 : top / entry.events, topValue });
  });
  return stats;
}

export type RaterClass = "concentrated" | "uniform" | null;

/** A rater's class from what it did across the whole registry: concentrated first, then a scripted batch, else neither. */
export function classifyRater(stats: Pick<RaterStats, "events" | "agents" | "topValueShare">): RaterClass {
  if (stats.agents >= CONCENTRATED_MIN_AGENTS) return "concentrated";
  if (stats.events >= UNIFORM_MIN_EVENTS && stats.topValueShare >= UNIFORM_MIN_SHARE) return "uniform";
  return null;
}

/** What the registry holds about one agent: the wallet that registered it, the host of its link, and its link's hash. */
export type AgentFacts = { registrant: string | null; host: string | null; linkHash: string | null };

/** What the registry holds about the wallets and agents the check compares. */
export type RegistryFacts = {
  /** By agent id. An agent the registry rows do not hold has no entry, and is not tied to anything. */
  agents: ReadonlyMap<number, AgentFacts>;
  /** Registrations by wallet, over the whole registry. A wallet with no entry registered none. */
  registrations: ReadonlyMap<string, number>;
  /** For a wallet that registered agents: the hosts and link hashes of those agents. Needed for the raters only. */
  registeredLinks: ReadonlyMap<string, { hosts: ReadonlySet<string>; hashes: ReadonlySet<string> }>;
};

/** Why a rater is tied to an agent's owner or fleet, or null when it is not. */
export function linkOf(client: string, agent: AgentFacts | undefined, facts: Pick<RegistryFacts, "registrations" | "registeredLinks">): "owner" | "fleet_wallet" | "same_link" | null {
  if (agent?.registrant && client === agent.registrant) return "owner";
  if ((facts.registrations.get(client) ?? 0) >= OWNER_FLEET_MIN) return "fleet_wallet";
  const own = facts.registeredLinks.get(client);
  if (own && agent && ((agent.host !== null && own.hosts.has(agent.host)) || (agent.linkHash !== null && own.hashes.has(agent.linkHash)))) return "same_link";
  return null;
}

type AgentRaterResult = {
  agentId: number;
  /** Ratings that stand. */
  rawEvents: number;
  /** Distinct raters. rawRaters = concentrated + uniform + linked + independent. */
  rawRaters: number;
  concentratedRaters: number;
  uniformRaters: number;
  linkedRaters: number;
  independentRaters: number;
  /** Ratings from the independent raters. The others have weight 0. */
  weightedEvents: number;
  ownerRegistrations: number;
  ownerFleet: boolean;
  qualifies: boolean;
};

/**
 * The result for every agent that has a rating that stands. A rater is counted once for an agent, under the first rule that
 * applies: concentrated, then a scripted batch, then tied to the owner or fleet, then independent. An agent qualifies with three
 * independent raters unless its owner is a fleet wallet, which puts the agent in a fleet (gate G1) whatever its raters say.
 */
export function rateAgents(feedback: readonly FeedbackEvent[], facts: RegistryFacts, classes?: ReadonlyMap<string, RaterClass>): Map<number, AgentRaterResult> {
  const classOf = classes ?? new Map(Array.from(raterStats(feedback), ([client, stats]) => [client, classifyRater(stats)] as const));
  const byAgent = new Map<number, Map<string, number>>();
  for (const event of feedback) {
    let raters = byAgent.get(event.agentId);
    if (!raters) {
      raters = new Map();
      byAgent.set(event.agentId, raters);
    }
    raters.set(event.client, (raters.get(event.client) ?? 0) + 1);
  }
  const results = new Map<number, AgentRaterResult>();
  byAgent.forEach((raters, agentId) => {
    const agent = facts.agents.get(agentId);
    let concentratedRaters = 0;
    let uniformRaters = 0;
    let linkedRaters = 0;
    let independentRaters = 0;
    let rawEvents = 0;
    let weightedEvents = 0;
    raters.forEach((events, client) => {
      rawEvents += events;
      const kind = classOf.get(client) ?? null;
      if (kind === "concentrated") concentratedRaters += 1;
      else if (kind === "uniform") uniformRaters += 1;
      else if (linkOf(client, agent, facts) !== null) linkedRaters += 1;
      else {
        independentRaters += 1;
        weightedEvents += events;
      }
    });
    const ownerRegistrations = agent?.registrant ? (facts.registrations.get(agent.registrant) ?? 0) : 0;
    const ownerFleet = ownerRegistrations >= OWNER_FLEET_MIN;
    results.set(agentId, {
      agentId,
      rawEvents,
      rawRaters: raters.size,
      concentratedRaters,
      uniformRaters,
      linkedRaters,
      independentRaters,
      weightedEvents,
      ownerRegistrations,
      ownerFleet,
      qualifies: independentRaters >= MIN_INDEPENDENT_RATERS && !ownerFleet,
    });
  });
  return results;
}

/** How many agents are left after each rule, as counts: the report's table. */
export type RaterReport = {
  ratings: number;
  raters: number;
  agentsRated: number;
  concentratedRaters: number;
  concentratedEvents: number;
  uniformRaters: number;
  uniformEvents: number;
  /** Agents with three or more distinct raters, the upper bound that discounting starts from. */
  raw: number;
  /** The same, less the agents whose owner is a fleet wallet. */
  rawNotFleetOwned: number;
  afterConcentrated: number;
  afterUniform: number;
  afterLinked: number;
  /** Independent raters three or more, and the owner is not a fleet: the agents that qualify. */
  qualifying: number;
};

export function raterReport(feedback: readonly FeedbackEvent[], stats: ReadonlyMap<string, RaterStats>, classes: ReadonlyMap<string, RaterClass>, results: ReadonlyMap<number, AgentRaterResult>): RaterReport {
  let concentratedRaters = 0;
  let concentratedEvents = 0;
  let uniformRaters = 0;
  let uniformEvents = 0;
  stats.forEach((entry, client) => {
    const kind = classes.get(client) ?? null;
    if (kind === "concentrated") {
      concentratedRaters += 1;
      concentratedEvents += entry.events;
    } else if (kind === "uniform") {
      uniformRaters += 1;
      uniformEvents += entry.events;
    }
  });
  const report: RaterReport = { ratings: feedback.length, raters: stats.size, agentsRated: results.size, concentratedRaters, concentratedEvents, uniformRaters, uniformEvents, raw: 0, rawNotFleetOwned: 0, afterConcentrated: 0, afterUniform: 0, afterLinked: 0, qualifying: 0 };
  results.forEach(result => {
    if (result.rawRaters >= MIN_INDEPENDENT_RATERS) {
      report.raw += 1;
      if (!result.ownerFleet) report.rawNotFleetOwned += 1;
    }
    if (result.rawRaters - result.concentratedRaters >= MIN_INDEPENDENT_RATERS) report.afterConcentrated += 1;
    if (result.rawRaters - result.concentratedRaters - result.uniformRaters >= MIN_INDEPENDENT_RATERS) report.afterUniform += 1;
    if (result.independentRaters >= MIN_INDEPENDENT_RATERS) report.afterLinked += 1;
    if (result.qualifies) report.qualifying += 1;
  });
  return report;
}
