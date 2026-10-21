import { sanitizePublicText } from "./publicText";

/**
 * Presentation helpers for the public registry-ratings surface: the Robinhood
 * Chain ERC-8004 reputation ledger (agent_reputation_events) read onto an
 * acknowledged agent page. The ledger is complete from genesis and
 * reconciled against the chain; these helpers only shape what it already
 * recorded — the rater-submitted score, the tag text, and which ratings a
 * revocation names. No scoring, weighting, or judgement happens here.
 *
 * Kept pure and dependency-free apart from the shared text scrubber so the
 * public read path stays unit-testable without a database.
 */

/**
 * Must equal ROBINHOOD_IDENTITY_REGISTRY in server/ingestion/robinhood.ts
 * (declared here so this module never pulls the ingestion import graph).
 * Only ratings for agents in that registry are surfaceable.
 */
const APPROVED_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** What a Robinhood identity directory entry's externalKey starts with; the rated agent's token id follows it. */
export const REPUTATION_KEY_PREFIX = `eip155:4663:${APPROVED_IDENTITY_REGISTRY}:`;

/** One ledger row for a rated agent, before the revocation join. */
export type RatingsEventInput = {
  kind: "new_feedback" | "feedback_revoked" | "response_appended";
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  clientAddress: string;
  feedbackIndex: number | null;
  valueRaw: string | null;
  valueDecimals: number | null;
  tag1: string | null;
  tag2: string | null;
};

export type AgentDirectoryEntryRatingsEvent = RatingsEventInput & {
  /** True when a FeedbackRevoked names this rating's (client, feedbackIndex) triple. */
  revoked: boolean;
};

export type AgentDirectoryEntryRatings = {
  /** Highest ledger block for the reputation source — the measured-through boundary. */
  measuredThroughBlock: number | null;
  totalEvents: number;
  ratingCount: number;
  activeRatingCount: number;
  revokedCount: number;
  responseCount: number;
  events: AgentDirectoryEntryRatingsEvent[];
};

/**
 * Extracts the rated agent's registry token id from a Robinhood identity
 * directory entry's externalKey (`eip155:4663:<registry>:<agentId>`). Only
 * the approved identity registry qualifies — every other protocol, chain, or
 * key shape returns null so no other surface can inherit ratings by accident.
 */
export function parseReputationExternalKey(externalKey: string): number | null {
  const segments = externalKey.split(":");
  if (segments.length !== 4) return null;
  if (segments[0] !== "eip155" || segments[1] !== "4663") return null;
  if (segments[2] !== APPROVED_IDENTITY_REGISTRY) return null;
  if (!/^\d+$/.test(segments[3]!)) return null;
  const agentId = Number(segments[3]);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) return null;
  return agentId;
}

/**
 * Exact decimal shift of a rater-submitted score — string math over the
 * stored decimal, never a float. `"2500000", 6` → `"2.5"`; `"5", 6` →
 * `"0.000005"`; negative scores keep their sign; trailing fraction zeros are
 * presentation-only and trimmed.
 */
export function formatRatingValue(valueRaw: string, valueDecimals: number): string {
  const decimals = Number.isFinite(valueDecimals) && valueDecimals > 0 ? Math.floor(valueDecimals) : 0;
  const negative = valueRaw.startsWith("-");
  const magnitude = negative ? valueRaw.slice(1) : valueRaw;
  const digits = /^\d+$/.test(magnitude) ? magnitude : "0";
  let text: string;
  if (decimals === 0) {
    text = digits;
  } else if (digits.length <= decimals) {
    text = `0.${"0".repeat(decimals - digits.length)}${digits}`;
  } else {
    const point = digits.length - decimals;
    text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return `${negative && digits !== "0" ? "-" : ""}${text}`;
}

/**
 * Builds the public ratings block from one agent's ledger rows (chain order
 * preserved: blockNumber, then logIndex). A FeedbackRevoked row never hides
 * the rating it names — the rating is marked `revoked` and stays in the list;
 * untrusted tag text goes through the shared public-text scrubber at read
 * time, matching how every other source-served string reaches the API.
 */
export function computeRatingsSummary(
  events: RatingsEventInput[],
  measuredThroughBlock: number | null
): AgentDirectoryEntryRatings {
  const revokedKeys = new Set<string>();
  for (const event of events) {
    if (event.kind === "feedback_revoked" && typeof event.feedbackIndex === "number") {
      revokedKeys.add(`${event.clientAddress.toLowerCase()}\u0000${event.feedbackIndex}`);
    }
  }
  const mapped = events.map(event => ({
    ...event,
    feedbackIndex: typeof event.feedbackIndex === "number" ? event.feedbackIndex : null,
    tag1: sanitizePublicText(event.tag1, 512),
    tag2: sanitizePublicText(event.tag2, 512),
    revoked:
      event.kind === "new_feedback" &&
      typeof event.feedbackIndex === "number" &&
      revokedKeys.has(`${event.clientAddress.toLowerCase()}\u0000${event.feedbackIndex}`),
  }));
  const ratingCount = events.filter(event => event.kind === "new_feedback").length;
  const revokedMarked = mapped.filter(event => event.kind === "new_feedback" && event.revoked).length;
  return {
    measuredThroughBlock,
    totalEvents: events.length,
    ratingCount,
    activeRatingCount: ratingCount - revokedMarked,
    revokedCount: events.filter(event => event.kind === "feedback_revoked").length,
    responseCount: events.filter(event => event.kind === "response_appended").length,
    events: mapped,
  };
}
