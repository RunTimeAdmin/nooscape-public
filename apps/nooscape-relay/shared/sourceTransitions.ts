/**
 * The decisions an operator may make about an ingestion source, from each state. The server refuses any other, and the console offers only
 * these: Approve and Reject a source in review, Pause an active one, Resume a paused one. A rejected source is final, as the console has
 * always had it: no decision leaves `rejected`, and staging the same source again finds the rejected row.
 */
export type SourceState = "review" | "active" | "paused" | "rejected";
export type SourceDecision = Exclude<SourceState, "review">;

export const SOURCE_TRANSITIONS: Readonly<Record<SourceState, readonly SourceDecision[]>> = {
  review: ["active", "rejected"],
  active: ["paused"],
  paused: ["active"],
  rejected: [],
};

export const canDecideSource = (from: SourceState, to: SourceDecision): boolean => SOURCE_TRANSITIONS[from].includes(to);
