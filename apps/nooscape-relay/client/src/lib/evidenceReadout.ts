import { publisherStateExplanations, tierExplanations, tierFromProof } from "./evidenceExplain";

/**
 * What the page says about one record's evidence, built only from fields the record
 * carries: its evidence tier, who published it and whether it was observed at all. It
 * replaces a 0 to 100 "trust vector" that was a display heuristic (72 or 42 from the
 * publisher state for observed records, a fixed number for the demo ones). A number like
 * that reads as a measurement, and nothing here measures how good an agent is.
 */
type ReadoutAgent = {
  /** For example "TIER_2 · 1 source". */
  proof: string;
  publisherValidation: { status: string };
};

/** The states a publisher key can be in. The router types a record's state as a plain string, so the page checks it with `toPublisherState` and does not assume it. */
export const PUBLISHER_STATES = ["allowlisted", "expired", "revoked", "unverified"] as const;
export type PublisherState = (typeof PUBLISHER_STATES)[number];

/** A state the page does not know is shown as the weakest one, never as a stronger one. */
export function toPublisherState(value: string): PublisherState {
  return PUBLISHER_STATES.find(state => state === value) ?? "unverified";
}

export type EvidenceReadout =
  | { kind: "observed"; tierLabel: string; tierSentence: string; publisherLabel: string; publisherSentence: string };

/** The tier names, weakest first. Order is for sorting only; it is never shown as a number. */
const TIER_ORDER = ["tier_2", "tier_3", "tier_4"];

/**
 * The groups the field's filter sorts every record into. A record is in exactly one, so the counts beside the filter
 * add up to the total. The strongest proof the record carries now decides: an active publisher key, then a current
 * domain-control check, and otherwise none (a key that has expired or been revoked proves nothing now).
 */
export type EvidenceGroup = "owner" | "website" | "none";

export function evidenceGroup(agent: ReadoutAgent): EvidenceGroup {
  if (agent.publisherValidation.status === "allowlisted") return "owner";
  if (tierFromProof(agent.proof) === "tier_3") return "website";
  return "none";
}

/** How many of the records are in each group. The three counts add up to the number of records. */
export function countByEvidenceGroup(agents: readonly ReadoutAgent[]): Record<EvidenceGroup, number> {
  const counts: Record<EvidenceGroup, number> = { owner: 0, website: 0, none: 0 };
  for (const agent of agents) counts[evidenceGroup(agent)] += 1;
  return counts;
}

/** Sort key for "sort by evidence": higher tiers first, then records with no tier. Never displayed. */
export function evidenceRank(agent: ReadoutAgent) {
  const tier = tierFromProof(agent.proof);
  return tier ? TIER_ORDER.indexOf(tier) + 2 : 1;
}

export function evidenceReadout(agent: ReadoutAgent): EvidenceReadout {
  const tier = tierFromProof(agent.proof);
  const explained = tier ? tierExplanations[tier] : undefined;
  const publisher = agent.publisherValidation.status;
  return {
    kind: "observed",
    tierLabel: explained?.label ?? "No evidence tier recorded",
    tierSentence: explained?.sentence ?? "Nooscape retained this record without a tier, so nothing about it is verified.",
    publisherLabel: `Publisher: ${publisher}`,
    publisherSentence: publisherStateExplanations[publisher] ?? publisherStateExplanations.unverified!,
  };
}

/** A short value for a cell that has room for a few words: "Tier 2", "No tier". */
export function evidenceSummary(agent: ReadoutAgent) {
  const tier = tierFromProof(agent.proof);
  return tier ? `Tier ${tier.slice(-1)}` : "No tier";
}

/** Whether two records differ in the evidence they carry, for the side by side view. */
export function evidenceDiffers(left: ReadoutAgent, right: ReadoutAgent) {
  return evidenceSummary(left) !== evidenceSummary(right) || left.publisherValidation.status !== right.publisherValidation.status;
}
