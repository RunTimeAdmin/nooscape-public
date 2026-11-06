import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, decide, reasonsToAsk, type CheckData, type Policy } from "../examples/preflight-policy";
import { checkFlags, type CheckFlagsInput } from "./apiCheck";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

type Listing = { name?: string; ageDays?: number; changes?: number; ratings?: { count: number; revoked: number } | null; sameHost?: number; nothingMeasured?: boolean };

/** One listing as the API's answer carries it: the flags come from checkFlags itself, so a renamed or reshaped field breaks these tests. */
function listing({ name = "Alpha", ageDays = 400, changes = 0, ratings = { count: 10, revoked: 0 }, sameHost = 0, nothingMeasured = false }: Listing = {}): CheckData["results"][number] {
  const input: CheckFlagsInput = {
    chain: "robinhood",
    now: NOW,
    entry: nothingMeasured
      ? { firstSeenAt: null, related: null, activity: null, ratings: null }
      : {
          firstSeenAt: new Date(NOW.getTime() - ageDays * DAY),
          related: { sameWallet: 0, sameName: 0, sameHost },
          activity: { secondaryTransferCount: changes, handoutCount: 0, events: [] },
          ratings: ratings ? { measuredThroughBlock: 500, ratingCount: ratings.count, revokedCount: ratings.revoked } : null,
        },
    facts: { activityThroughBlock: 1_000, solana: null },
  };
  // checkFlags types ownership_changes loosely (a record), so the cast goes through unknown; the tests below read the real values, which is what holds the field names.
  return { agent: { name }, flags: checkFlags(input) as unknown as CheckData["results"][number]["flags"] };
}

const answer = (...listings: Listing[]): CheckData => ({ results: listings.map(listing) });

describe("the reference pre-flight policy (examples/preflight-policy.ts)", () => {
  it("proceeds when it has nothing to ask about", () => {
    expect(decide(answer({}))).toEqual({ action: "proceed", reasons: [], notMeasured: [] });
  });

  it("asks a person about a listing Nooscape first saw fewer than the policy's days ago, and not at the day itself", () => {
    expect(reasonsToAsk(answer({ ageDays: 10 }))).toEqual(["Alpha: first seen 10 days ago (2026-10-26T12:00:00.000Z)"]);
    expect(reasonsToAsk(answer({ ageDays: 29 }))).toHaveLength(1);
    expect(reasonsToAsk(answer({ ageDays: 30 }))).toEqual([]);
  });

  it("asks about a recorded ownership change, from the first one", () => {
    expect(reasonsToAsk(answer({ changes: 2 }))).toEqual(["Alpha: 2 ownership change(s) recorded"]);
    expect(reasonsToAsk(answer({ changes: 1 }))).toEqual(["Alpha: 1 ownership change(s) recorded"]);
    expect(reasonsToAsk(answer({ changes: 0 }))).toEqual([]);
  });

  it("asks when the revoked share of the ratings reaches the policy's share, and not below it", () => {
    expect(reasonsToAsk(answer({ ratings: { count: 10, revoked: 2 } }))).toEqual(["Alpha: 2 of 10 ratings were revoked by the rater"]);
    expect(reasonsToAsk(answer({ ratings: { count: 10, revoked: 1 } }))).toEqual([]);
  });

  it("asks when enough other listings share the host, and not below it", () => {
    expect(reasonsToAsk(answer({ sameHost: 10 }))).toEqual(["Alpha: 10 other listings share its host"]);
    expect(reasonsToAsk(answer({ sameHost: 9 }))).toEqual([]);
  });

  it("takes its thresholds from the policy: they are the caller's to choose", () => {
    const strict: Policy = { ...DEFAULT_POLICY, newerThanDays: 500, sameHostFrom: 3, revokedShareFrom: 0.05 };
    expect(reasonsToAsk(answer({ ageDays: 400, sameHost: 3, ratings: { count: 20, revoked: 1 } }), strict)).toHaveLength(3);
    const relaxed: Policy = { ...DEFAULT_POLICY, newerThanDays: 5 };
    expect(reasonsToAsk(answer({ ageDays: 10 }), relaxed)).toEqual([]);
  });

  it("applies the policy it is given when it decides, not only when it lists reasons", () => {
    expect(decide(answer({ ageDays: 10 })).action).toBe("ask a person");
    expect(decide(answer({ ageDays: 10 }), { ...DEFAULT_POLICY, newerThanDays: 5 }).action).toBe("proceed");
  });

  it("asks about nothing it has not measured, however low the thresholds are set, and lists what is missing", () => {
    const lowest: Policy = { newerThanDays: Number.POSITIVE_INFINITY, ownershipChangesFrom: 0, revokedShareFrom: 0, sameHostFrom: 0, whenNotListed: "ask a person" };
    for (const policy of [DEFAULT_POLICY, lowest]) {
      const result = decide(answer({ nothingMeasured: true }), policy);
      expect(result.reasons).toEqual([]);
      expect(result.action).toBe("proceed");
      expect(result.notMeasured).toEqual([
        "Alpha: first seen is not measured for this agent",
        "Alpha: ownership changes is not measured for this agent",
        "Alpha: revoked feedback is not measured for this agent",
        "Alpha: fleet size is not measured for this agent",
      ]);
    }
  });

  it("treats an agent that is not listed as the policy says, and says that it tells nothing about the agent", () => {
    for (const data of [null, { results: [] }]) {
      const asked = decide(data);
      expect(asked.action).toBe("ask a person");
      expect(asked.reasons[0]).toContain("says nothing about the agent");
      const passed = decide(data, { ...DEFAULT_POLICY, whenNotListed: "proceed" });
      expect(passed).toMatchObject({ action: "proceed", reasons: [] });
      expect(passed.notMeasured[0]).toContain("says nothing about the agent");
    }
  });

  it("lists a flag that is not measured and counts it neither way", () => {
    // ratings are read on Robinhood Chain only: with none the flag is null, which is not the same as none revoked
    const result = decide(answer({ ratings: null }));
    expect(result.action).toBe("proceed");
    expect(result.reasons).toEqual([]);
    expect(result.notMeasured).toEqual(["Alpha: revoked feedback is not measured for this agent"]);
  });

  it("names the listing that raised each reason when an answer holds several", () => {
    const result = decide(answer({ name: "Quiet" }, { name: "Loud", ratings: { count: 4, revoked: 4 } }));
    expect(result.action).toBe("ask a person");
    expect(result.reasons).toEqual(["Loud: 4 of 4 ratings were revoked by the rater"]);
  });
});
