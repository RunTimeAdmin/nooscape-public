import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChainStat, ExtraChainKey, ExtraChainStat } from "@shared/chains";
import {
  archiveMeta,
  ARCHIVE_PATH,
  ARCHIVE_TITLE,
  candidateCatches,
  catchPath,
  catchUrl,
  dateLabel,
  dayMeta,
  dayTitle,
  daysBetween,
  detailOf,
  eligibleFleets,
  FLEET_SOURCE_QUERY,
  formatCount,
  headlineOf,
  howWeKnowOf,
  isCatchDate,
  MAX_AGENT_IDS,
  milestoneFor,
  MILESTONE_SOURCE_QUERY,
  noCatchMeta,
  notADateMeta,
  NOVELTY_DAYS,
  newMilestones,
  parseAgentIds,
  parseFacts,
  recentMilestone,
  SITE_ORIGIN,
  shortWallet,
  utcDate,
  viewOf,
  type CatchRow,
  type FleetFacts,
  type MilestoneFacts,
  type PastCatch,
} from "@shared/owlsCatch";
import { FLEET_MIN } from "@shared/noosphere";

/**
 * The Owl's Catch rules and words, with no database: which day's finding is chosen from which counts, what is
 * left alone, and that every figure in a headline is one the stored facts hold. The storage, the visibility of
 * the entries behind a fleet and the daily selection against a real database are in owlsCatch.integration.test.ts.
 */
const wallet = (registrant: string | null, agentCount: number, dominantHost: string | null = null) => ({ registrant, agentCount, dominantHost });
const chain = (key: ChainStat["chain"], over: Partial<ChainStat> = {}): ChainStat => ({ chain: key, indexed: true, acknowledged: 3, reviewed: 3, feedbackEvents: null, registries: [], asOf: "2026-10-15T06:00:00.000Z", ...over });
const extra = (key: ExtraChainKey, over: Partial<ExtraChainStat> = {}): ExtraChainStat => ({ chain: key, indexed: true, acknowledged: 3, reviewed: 0, feedbackEvents: null, registries: [], asOf: "2026-10-20T16:45:00.000Z", registry: null, ...over });
const past = (date: string, rule: PastCatch["rule"], facts: unknown): PastCatch => ({ date, rule, facts });
const fleetFacts = (registrant: string, agentCount = 100, dominantHost: string | null = null): FleetFacts => ({ registrant, agentCount, dominantHost });
const milestoneFacts = (over: Partial<MilestoneFacts> = {}): MilestoneFacts => ({ chain: "robinhood", metric: "reviewed", milestone: 100, value: 110, asOf: "2026-10-15T06:00:00.000Z", ...over });
const row = (over: Partial<CatchRow> = {}): CatchRow => ({
  catchDate: "2026-10-15",
  rule: "fleet",
  facts: JSON.stringify(fleetFacts("0x62d304d1df6b102c43470a4b27f53bc4c009575c", 5593, "bv7x.ai")),
  sourceQuery: FLEET_SOURCE_QUERY,
  agentIds: JSON.stringify(["a1", "a2"]),
  selectedAt: "2026-10-15T00:15:02.000Z",
  ...over,
});

describe("round numbers", () => {
  it("climb in ones, two and a halves and fives of each power of ten, from ten", () => {
    expect(milestoneFor(9)).toBeNull();
    expect(milestoneFor(10)).toBe(10);
    expect(milestoneFor(24)).toBe(10);
    expect(milestoneFor(25)).toBe(25);
    expect(milestoneFor(49)).toBe(25);
    expect(milestoneFor(50)).toBe(50);
    expect(milestoneFor(99)).toBe(50);
    expect(milestoneFor(100)).toBe(100);
    expect(milestoneFor(249)).toBe(100);
    expect(milestoneFor(250)).toBe(250);
    expect(milestoneFor(8_798)).toBe(5_000);
    expect(milestoneFor(10_000)).toBe(10_000);
    expect(milestoneFor(246_850)).toBe(100_000);
    expect(milestoneFor(250_000)).toBe(250_000);
    expect(milestoneFor(Number.NaN)).toBeNull();
    expect(milestoneFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("count as recent only while the figure is under a quarter above them", () => {
    expect(recentMilestone(10_000)).toBe(10_000);
    expect(recentMilestone(12_499)).toBe(10_000);
    expect(recentMilestone(12_500)).toBeNull();
    expect(recentMilestone(8_798)).toBeNull();
    expect(recentMilestone(250)).toBe(250);
    expect(recentMilestone(249)).toBeNull();
    expect(recentMilestone(5)).toBeNull();
  });
});

describe("the fleets that may be featured", () => {
  it("are real fleets: at least the fleet minimum, with a wallet, largest first, the wallet's name breaking a tie", () => {
    const fleets = eligibleFleets([wallet("0xb", FLEET_MIN), wallet("0xa", FLEET_MIN), wallet("0xsmall", FLEET_MIN - 1), wallet(null, 9_000), wallet("0xbig", 5_000)], [], "2026-10-15");
    expect(fleets.map(fleet => fleet.registrant)).toEqual(["0xbig", "0xa", "0xb"]);
  });

  it("leave out a wallet featured in the last thirty days, and take it back on the thirtieth", () => {
    expect(NOVELTY_DAYS).toBe(30);
    const both = [wallet("0xbig", 5_000), wallet("0xnext", 900)];
    // Twenty-nine days ago is still this month; thirty days ago is not.
    expect(eligibleFleets(both, [past("2026-09-16", "fleet", fleetFacts("0xbig"))], "2026-10-15").map(fleet => fleet.registrant)).toEqual(["0xnext"]);
    expect(eligibleFleets(both, [past("2026-09-15", "fleet", fleetFacts("0xbig"))], "2026-10-15").map(fleet => fleet.registrant)).toEqual(["0xbig", "0xnext"]);
  });

  it("are not held back by a milestone that was featured, or by a past catch whose facts do not read", () => {
    const earlier = [past("2026-10-14", "milestone", milestoneFacts()), past("2026-10-13", "fleet", { registrant: 4 }), past("2026-10-12", "none", {})];
    expect(eligibleFleets([wallet("0xbig", 5_000)], earlier, "2026-10-15")).toHaveLength(1);
    // Only a day that featured a fleet holds a wallet back, whatever else its facts say.
    expect(eligibleFleets([wallet("0xbig", 5_000)], [past("2026-10-14", "milestone", fleetFacts("0xbig")), past("2026-10-13", "none", fleetFacts("0xbig"))], "2026-10-15")).toHaveLength(1);
  });

  it("keep the wallet's host, or none", () => {
    expect(eligibleFleets([wallet("0xhost", 80, "bv7x.ai"), wallet("0xnone", 70)], [], "2026-10-15")).toEqual([fleetFacts("0xhost", 80, "bv7x.ai"), fleetFacts("0xnone", 70, null)]);
  });
});

describe("the milestones that may be featured", () => {
  it("are the round numbers a chain has just passed, reviewed records before acknowledged entries, chain by chain", () => {
    const chains = [chain("bnb", { reviewed: 26, acknowledged: 10_100 }), chain("robinhood", { reviewed: 51, acknowledged: 5_100 }), chain("solana", { reviewed: 7, acknowledged: 12_300 })];
    const found = newMilestones(chains, []);
    expect(found.map(item => [item.chain, item.metric, item.milestone, item.value])).toEqual([
      ["robinhood", "reviewed", 50, 51],
      ["robinhood", "acknowledged", 5_000, 5_100],
      ["solana", "acknowledged", 10_000, 12_300],
      ["bnb", "reviewed", 25, 26],
      ["bnb", "acknowledged", 10_000, 10_100],
    ]);
    expect(found[0]!.asOf).toBe("2026-10-15T06:00:00.000Z");
  });

  it("skip a chain that is not indexed, and a count that is not measured", () => {
    const chains = [chain("robinhood", { indexed: false, reviewed: 51 }), chain("solana", { reviewed: null, acknowledged: null }), chain("bnb", { reviewed: 3, acknowledged: 4 })];
    expect(newMilestones(chains, [])).toEqual([]);
    expect(newMilestones([], [])).toEqual([]);
  });

  it("do not say a round number twice, nor one lower than one already said, but do say the next", () => {
    const chains = [chain("robinhood", { reviewed: 51, acknowledged: 3 })];
    expect(newMilestones(chains, [past("2026-10-01", "milestone", milestoneFacts({ metric: "reviewed", milestone: 50, value: 52 }))])).toEqual([]);
    expect(newMilestones(chains, [past("2026-10-01", "milestone", milestoneFacts({ metric: "reviewed", milestone: 100, value: 101 }))])).toEqual([]);
    expect(newMilestones(chains, [past("2026-10-01", "milestone", milestoneFacts({ metric: "reviewed", milestone: 25, value: 26 }))]).map(item => item.milestone)).toEqual([50]);
    // Another chain's, or another metric's, does not count.
    expect(newMilestones(chains, [past("2026-10-01", "milestone", milestoneFacts({ chain: "solana", metric: "reviewed", milestone: 50 })), past("2026-10-01", "milestone", milestoneFacts({ metric: "acknowledged", milestone: 50 }))]).map(item => item.milestone)).toEqual([50]);
  });

  it("remember the highest round number said, whatever order the past comes in", () => {
    const chains = [chain("robinhood", { reviewed: 104, acknowledged: 3 })];
    const fifty = past("2026-10-01", "milestone", milestoneFacts({ metric: "reviewed", milestone: 50, value: 52 }));
    const hundred = past("2026-10-10", "milestone", milestoneFacts({ metric: "reviewed", milestone: 100, value: 101 }));
    expect(newMilestones(chains, [hundred, fifty])).toEqual([]);
    expect(newMilestones(chains, [fifty, hundred])).toEqual([]);
  });
});

describe("an extra chain's round numbers", () => {
  const arcFacts = milestoneFacts({ chain: "arc", metric: "acknowledged", milestone: 250, value: 252, asOf: "2026-10-20T16:45:00.000Z" });
  const arcRow = (over: Partial<CatchRow> = {}) => row({ rule: "milestone", facts: JSON.stringify(arcFacts), sourceQuery: MILESTONE_SOURCE_QUERY, ...over });

  it("are the round numbers its row has just passed, said after the original three's, and nothing for a chain the caller gives no row for", () => {
    const found = newMilestones([chain("robinhood", { reviewed: 51, acknowledged: 3 }), extra("arc", { acknowledged: 252 })], []);
    expect(found.map(item => [item.chain, item.metric, item.milestone, item.value])).toEqual([["robinhood", "reviewed", 50, 51], ["arc", "acknowledged", 250, 252]]);
    expect(found[1]!.asOf).toBe("2026-10-20T16:45:00.000Z");
    // The server gives a row only while the chain's switch is on, so with none there is nothing to say about the chain.
    expect(newMilestones([chain("robinhood", { reviewed: 51, acknowledged: 3 })], []).some(item => item.chain === "arc")).toBe(false);
  });

  it("skip an extra chain that is not indexed, a count that is not measured and a count under ten", () => {
    expect(newMilestones([extra("arc", { indexed: false, acknowledged: 252 })], [])).toEqual([]);
    expect(newMilestones([extra("arc", { acknowledged: null, reviewed: null })], [])).toEqual([]);
    expect(newMilestones([extra("arc", { acknowledged: 9 })], [])).toEqual([]);
    // A count that passed a round number a while ago is not new: 246 has passed 100 by far, and has not reached 250.
    expect(newMilestones([extra("arc", { acknowledged: 246 })], [])).toEqual([]);
  });

  it("do not say a round number twice for the chain, and do say the next, and another chain's does not count", () => {
    const said = past("2026-10-21", "milestone", arcFacts);
    expect(newMilestones([extra("arc", { acknowledged: 252 })], [said])).toEqual([]);
    expect(newMilestones([extra("arc", { acknowledged: 505 })], [said]).map(item => item.milestone)).toEqual([500]);
    expect(newMilestones([extra("arc", { acknowledged: 252 })], [past("2026-10-21", "milestone", milestoneFacts({ chain: "bnb", metric: "acknowledged", milestone: 250, value: 251 }))]).map(item => item.milestone)).toEqual([250]);
  });

  it("are a candidate with the read it came from, ahead of any fleet", () => {
    const [first, second] = candidateCatches({ date: "2026-10-21", wallets: [wallet("0xbig", 5_000)], chains: [extra("arc", { acknowledged: 252 })], past: [] });
    expect(first).toMatchObject({ rule: "milestone", sourceQuery: MILESTONE_SOURCE_QUERY, facts: { chain: "arc", metric: "acknowledged", milestone: 250, value: 252 } });
    expect(second).toMatchObject({ rule: "fleet" });
  });

  it("are said in the chain's own name, from the stored facts, and read back for the extra chains and no other name", () => {
    expect(headlineOf("milestone", arcFacts)).toBe("Arc has passed 250 acknowledged entries.");
    expect(detailOf("milestone", arcFacts)).toBe("The count is 252 under the public rules.");
    expect(howWeKnowOf("milestone", arcFacts, "2026-10-21", MILESTONE_SOURCE_QUERY)).toContain("Last successful read of this chain: 2026-10-20T16:45:00.000Z.");
    expect(parseFacts("milestone", JSON.stringify(arcFacts))).toEqual(arcFacts);
    for (const key of ["ethereum", "base"] as const) expect(parseFacts("milestone", JSON.stringify({ ...arcFacts, chain: key })), key).toMatchObject({ chain: key });
    expect(parseFacts("milestone", JSON.stringify({ ...arcFacts, chain: "cosmos" }))).toBeNull();
  });

  it("are shown only while the chain's switch is on in the list given, and the original three always are", () => {
    expect(viewOf(arcRow(), "chain_arc")!.headline).toBe("Arc has passed 250 acknowledged entries.");
    expect(viewOf(arcRow(), " Claims , CHAIN_ARC ")).not.toBeNull();
    for (const features of [undefined, "", "claims", "chain_base,chain_ethereum", "chain_arcade"]) expect(viewOf(arcRow(), features), String(features)).toBeNull();
    expect(viewOf(arcRow())).toBeNull();
    const original = row({ rule: "milestone", facts: JSON.stringify(milestoneFacts()), sourceQuery: MILESTONE_SOURCE_QUERY });
    for (const features of [undefined, "", "chain_arc"]) expect(viewOf(original, features), String(features)).not.toBeNull();
    // A fleet is not about a chain and does not depend on a switch.
    expect(viewOf(row())).not.toBeNull();
  });
});

describe("the day's candidates", () => {
  const input = { date: "2026-10-15", wallets: [wallet("0xbig", 5_000), wallet("0xnext", 900)], chains: [chain("robinhood", { reviewed: 51 })], past: [] as PastCatch[] };

  it("put a milestone first and then the largest fleet, each with the read it came from", () => {
    const candidates = candidateCatches(input);
    expect(candidates.map(candidate => candidate.rule)).toEqual(["milestone", "fleet", "fleet"]);
    expect(candidates[0]!.sourceQuery).toBe(MILESTONE_SOURCE_QUERY);
    expect(candidates[1]!.sourceQuery).toBe(FLEET_SOURCE_QUERY);
    expect((candidates[1]!.facts as FleetFacts).registrant).toBe("0xbig");
  });

  it("are the same for the same counts and the same past, whatever order the wallets come in", () => {
    expect(candidateCatches({ ...input, wallets: [...input.wallets].reverse() })).toEqual(candidateCatches(input));
    expect(JSON.stringify(candidateCatches(input))).toBe(JSON.stringify(candidateCatches(input)));
  });

  it("are none when nothing qualifies, which is a day with no catch", () => {
    expect(candidateCatches({ date: "2026-10-15", wallets: [wallet("0xsmall", FLEET_MIN - 1)], chains: [chain("robinhood")], past: [] })).toEqual([]);
    expect(candidateCatches({ date: "2026-10-15", wallets: [], chains: [], past: [] })).toEqual([]);
  });

  it("move down the fleets as each is featured, one a day, and run out when all have been", () => {
    const fleets = [wallet("0xa", 300), wallet("0xb", 200), wallet("0xc", 100)];
    const pastCatches: PastCatch[] = [];
    const chosen: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      const date = utcDate(new Date(Date.UTC(2026, 9, 1 + day)));
      const first = candidateCatches({ date, wallets: fleets, chains: [], past: pastCatches })[0];
      if (first && first.rule === "fleet") {
        chosen.push(first.facts.registrant);
        pastCatches.push(past(date, "fleet", first.facts));
      } else chosen.push("none");
    }
    expect(chosen).toEqual(["0xa", "0xb", "0xc", "none"]);
  });
});

describe("the words", () => {
  const fleet = fleetFacts("0x62d304d1df6b102c43470a4b27f53bc4c009575c", 5_593, "bv7x.ai");
  const milestone = milestoneFacts({ chain: "bnb", metric: "acknowledged", milestone: 10_000, value: 10_412 });

  it("say a fleet as a count of identities against a registering wallet, and a milestone as a round number passed", () => {
    expect(headlineOf("fleet", fleet)).toBe("One registering wallet is recorded against 5,593 identities.");
    expect(detailOf("fleet", fleet)).toBe("Wallet 0x62d3…575c. The most common locator host among them is bv7x.ai. A registering wallet shows who registered, not who holds or runs the agents.");
    expect(detailOf("fleet", { ...fleet, dominantHost: null })).toBe("Wallet 0x62d3…575c. A registering wallet shows who registered, not who holds or runs the agents.");
    expect(headlineOf("milestone", milestone)).toBe("BNB Chain has passed 10,000 acknowledged entries.");
    expect(headlineOf("milestone", milestoneFacts({ metric: "reviewed", milestone: 250 }))).toBe("Robinhood Chain has passed 250 reviewed records.");
    expect(detailOf("milestone", milestone)).toBe("The count is 10,412 under the public rules.");
  });

  it("say how it was known: the day, the rule, the read, the public rules and, for a milestone, when the chain was last read", () => {
    const how = howWeKnowOf("fleet", fleet, "2026-10-15", FLEET_SOURCE_QUERY);
    expect(how).toContain("Chosen on 2026-10-15 (UTC) by a fixed rule, not by hand.");
    expect(how).toContain(`at least ${FLEET_MIN}`);
    expect(how).toContain(`last ${NOVELTY_DAYS} days`);
    expect(how).toContain(FLEET_SOURCE_QUERY);
    expect(how).toContain("nothing hidden, withdrawn or from an unapproved source is in it");
    expect(howWeKnowOf("milestone", milestone, "2026-10-15", MILESTONE_SOURCE_QUERY)).toContain("Last successful read of this chain: 2026-10-15T06:00:00.000Z.");
    expect(howWeKnowOf("milestone", { ...milestone, asOf: null }, "2026-10-15", MILESTONE_SOURCE_QUERY)).toContain("Last successful read of this chain: not recorded.");
  });

  it("hold no figure that the stored facts, the date and the rule do not hold", () => {
    for (const [rule, facts, query] of [["fleet", fleet, FLEET_SOURCE_QUERY], ["milestone", milestone, MILESTONE_SOURCE_QUERY]] as const) {
      let text = [headlineOf(rule, facts), detailOf(rule, facts), howWeKnowOf(rule, facts, "2026-10-15", query)].join(" ");
      const known = rule === "fleet" ? [formatCount((facts as FleetFacts).agentCount), shortWallet((facts as FleetFacts).registrant), (facts as FleetFacts).dominantHost ?? "", String(FLEET_MIN), String(NOVELTY_DAYS)] : [formatCount((facts as MilestoneFacts).milestone), formatCount((facts as MilestoneFacts).value), (facts as MilestoneFacts).asOf ?? ""];
      // What the facts hold first, then the date, since a time the facts hold has the date inside it.
      for (const value of [...known, "2026-10-15"]) if (value) text = text.split(value).join("");
      expect(text, rule).not.toMatch(/\d/);
    }
  });

  it("change with each stored value that they are built from, so each is the database's and none is added", () => {
    const base = viewOf(row())!;
    expect(viewOf(row({ facts: JSON.stringify({ ...fleet, agentCount: 5_594 }) }))!.headline).not.toBe(base.headline);
    expect(viewOf(row({ facts: JSON.stringify({ ...fleet, dominantHost: "other.example" }) }))!.detail).toContain("other.example");
    expect(viewOf(row({ facts: JSON.stringify({ ...fleet, registrant: "0xffff000000000000000000000000000000001234" }) }))!.detail).toContain("0xffff…1234");
    const rule = row({ rule: "milestone", facts: JSON.stringify(milestone), sourceQuery: MILESTONE_SOURCE_QUERY });
    expect(viewOf(rule)!.headline).toContain("BNB Chain");
    expect(viewOf({ ...rule, facts: JSON.stringify({ ...milestone, chain: "solana" }) })!.headline).toContain("Solana");
    expect(viewOf({ ...rule, facts: JSON.stringify({ ...milestone, metric: "reviewed" }) })!.headline).toContain("reviewed records");
    expect(viewOf({ ...rule, facts: JSON.stringify({ ...milestone, milestone: 25_000 }) })!.headline).toContain("25,000");
    expect(viewOf({ ...rule, facts: JSON.stringify({ ...milestone, value: 10_999 }) })!.detail).toContain("10,999");
    expect(viewOf(row({ sourceQuery: "another read" }))!.howWeKnow).toContain("another read");
    expect(viewOf(row({ catchDate: "2026-10-16" }))!.howWeKnow).toContain("2026-10-16");
  });

  it("make no accusation and no score, and carry no long dash", () => {
    const text = [viewOf(row())!, viewOf(row({ rule: "milestone", facts: JSON.stringify(milestone), sourceQuery: MILESTONE_SOURCE_QUERY }))!].flatMap(view => [view.headline, view.detail, view.howWeKnow]).join(" ");
    expect(text).not.toMatch(/scam|fake|fraud|malicious|spam|suspicious|rug|score|rank|rating|verdict of|worst|best/i);
    expect(text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
    expect(readFileSync(new URL("../shared/owlsCatch.ts", import.meta.url), "utf8")).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });
});

describe("what a stored row says", () => {
  it("is a view of its stored facts, with the fleet's identities in the order they were stored", () => {
    const view = viewOf(row())!;
    expect(view.date).toBe("2026-10-15");
    expect(view.rule).toBe("fleet");
    expect(view.agentIds).toEqual(["a1", "a2"]);
    expect(view.selectedAt).toBe("2026-10-15T00:15:02.000Z");
  });

  it("is nothing for a day with no catch, a rule it does not know, a date that is not one, or facts that do not read", () => {
    expect(viewOf(row({ rule: "none", facts: "{}" }))).toBeNull();
    expect(viewOf(row({ rule: "mystery" }))).toBeNull();
    expect(viewOf(row({ catchDate: "2026-13-40" }))).toBeNull();
    expect(viewOf(row({ catchDate: "yesterday" }))).toBeNull();
    expect(viewOf(row({ facts: "not json" }))).toBeNull();
    expect(viewOf(row({ facts: JSON.stringify({ registrant: "0xa" }) }))).toBeNull();
    expect(viewOf(row({ facts: JSON.stringify({ registrant: "0xa", agentCount: -3, dominantHost: null }) }))).toBeNull();
    expect(viewOf(row({ facts: JSON.stringify({ registrant: "0xa", agentCount: 1.5, dominantHost: null }) }))).toBeNull();
    expect(viewOf(row({ facts: JSON.stringify({ registrant: "0xa", agentCount: 60, dominantHost: 7 }) }))).toBeNull();
    expect(viewOf(row({ facts: JSON.stringify({ registrant: "0xa", agentCount: 60, dominantHost: "  " }) }))).toBeNull();
    expect(viewOf(row({ rule: "milestone", facts: JSON.stringify({ chain: "cosmos", metric: "reviewed", milestone: 100, value: 110, asOf: null }) }))).toBeNull();
    expect(viewOf(row({ rule: "milestone", facts: JSON.stringify({ chain: "solana", metric: "feedback", milestone: 100, value: 110, asOf: null }) }))).toBeNull();
  });

  it("keeps the identities of a fleet only, and no more than the limit", () => {
    const many = JSON.stringify(Array.from({ length: MAX_AGENT_IDS + 5 }, (_, index) => `id-${index}`));
    expect(viewOf(row({ agentIds: many }))!.agentIds).toHaveLength(MAX_AGENT_IDS);
    expect(viewOf(row({ rule: "milestone", facts: JSON.stringify(milestoneFacts()), agentIds: many }))!.agentIds).toEqual([]);
    expect(parseAgentIds("not json")).toEqual([]);
    expect(parseAgentIds(JSON.stringify([1, "ok", "", null]))).toEqual(["ok"]);
    expect(parseAgentIds(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("falls back to the date when the time it was chosen does not read", () => {
    expect(viewOf(row({ selectedAt: "never" }))!.selectedAt).toBe("2026-10-15");
    expect(viewOf(row({ selectedAt: new Date("2026-10-15T01:00:00Z") }))!.selectedAt).toBe("2026-10-15T01:00:00.000Z");
  });

  it("reads the facts of each rule, and nothing for a day with none", () => {
    expect(parseFacts("fleet", JSON.stringify(fleetFacts("0xa", 60)))).toEqual(fleetFacts("0xa", 60));
    expect(parseFacts("milestone", JSON.stringify(milestoneFacts()))).toEqual(milestoneFacts());
    expect(parseFacts("none", "{}")).toBeNull();
    expect(parseFacts("fleet", JSON.stringify(milestoneFacts()))).toBeNull();
    expect(parseFacts("milestone", JSON.stringify(fleetFacts("0xa", 60)))).toBeNull();
  });
});

describe("dates and wallets", () => {
  it("take the UTC calendar date, and know a date from something that only looks like one", () => {
    expect(utcDate(new Date("2026-10-15T23:59:59Z"))).toBe("2026-10-15");
    expect(utcDate(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10-16");
    expect(isCatchDate("2026-10-15")).toBe(true);
    expect(isCatchDate("2026-02-30")).toBe(false);
    expect(isCatchDate("2026-1-5")).toBe(false);
    expect(isCatchDate("2026-10-15T00:00")).toBe(false);
  });

  it("count whole days between dates, across a month and a leap day", () => {
    expect(daysBetween("2026-10-15", "2026-10-15")).toBe(0);
    expect(daysBetween("2026-09-16", "2026-10-15")).toBe(29);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("shorten a long address and leave a short one", () => {
    expect(shortWallet("0x62d304d1df6b102c43470a4b27f53bc4c009575c")).toBe("0x62d3…575c");
    expect(shortWallet("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe("9xQe…VFin");
    expect(shortWallet("0xabc")).toBe("0xabc");
  });
});

describe("the page around a catch", () => {
  it("writes a date the way people read it, and returns anything else as it came", () => {
    expect(dateLabel("2026-10-15")).toBe("15 Oct 2026");
    expect(dateLabel("2026-01-05")).toBe("5 Jan 2026");
    expect(dateLabel("2026-12-31")).toBe("31 Dec 2026");
    expect(dateLabel("2026-00-10")).toBe("2026-00-10");
    expect(dateLabel("2026-13-01")).toBe("2026-13-01");
    expect(dateLabel("yesterday")).toBe("yesterday");
  });

  it("addresses a day's page under /catch at the production site", () => {
    expect(ARCHIVE_PATH).toBe("/catch");
    expect(SITE_ORIGIN).toBe("https://nooscape.si");
    expect(catchPath("2026-10-15")).toBe("/catch/2026-10-15");
    expect(catchUrl("2026-10-15")).toBe("https://nooscape.si/catch/2026-10-15");
  });

  it("gives each kind of page its own title, heading, description and address", () => {
    const view = viewOf(row())!;
    expect(archiveMeta()).toMatchObject({ title: ARCHIVE_TITLE, heading: "The Owl's Catch", url: "https://nooscape.si/catch" });
    expect(dayMeta(view)).toMatchObject({ title: dayTitle("2026-10-15"), heading: "The Owl's Catch, 15 Oct 2026", url: "https://nooscape.si/catch/2026-10-15" });
    expect(dayTitle("2026-10-15")).toBe("The Owl's Catch, 15 Oct 2026 | Nooscape");
    expect(noCatchMeta("2026-10-12")).toMatchObject({ title: "No catch on 12 Oct 2026 | Nooscape", heading: "No catch on 12 Oct 2026", url: "https://nooscape.si/catch/2026-10-12" });
    expect(notADateMeta()).toMatchObject({ title: "That is not a date | Nooscape", url: "https://nooscape.si/catch" });
  });

  it("describes a day by its headline and a fixed sign-off, and nothing else", () => {
    const view = viewOf(row())!;
    expect(dayMeta(view).description).toBe(`${view.headline} One finding a day from Nooscape's public record, picked by a fixed rule; a count, never a score.`);
    expect(archiveMeta().description).toBe("One finding a day from Nooscape's public record, picked by a fixed rule; a count, never a score.");
    expect(noCatchMeta("2026-10-12").description).toBe("No catch was chosen for 12 Oct 2026.");
  });

  it("keeps the archive and the days that have a catch in search, and a day with none and a path that is not a date out of it", () => {
    const view = viewOf(row())!;
    expect(archiveMeta().robots).toBe("index, follow, max-image-preview:large");
    expect(dayMeta(view).robots).toBe("index, follow, max-image-preview:large");
    expect(noCatchMeta("2026-10-12").robots).toBe("noindex, follow");
    expect(notADateMeta().robots).toBe("noindex, follow");
  });

  it("carries no long dash and no score in any page's words", () => {
    const view = viewOf(row())!;
    for (const meta of [archiveMeta(), dayMeta(view), noCatchMeta("2026-10-12"), notADateMeta()]) {
      const words = `${meta.title} ${meta.heading} ${meta.description}`;
      expect(words).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
      expect(words).not.toMatch(/\d+\s*\/\s*100/);
    }
  });
});

describe.each([
  { key: "ethereum" as const, label: "Ethereum", feature: "chain_ethereum", others: "chain_base,chain_arc", value: 5_040, milestone: 5_000 },
  { key: "base" as const, label: "Base", feature: "chain_base", others: "chain_ethereum,chain_arc", value: 2_520, milestone: 2_500 },
])("$label's round numbers in the Owl's Catch", ({ key, label, feature, others, value, milestone }) => {
  const facts = milestoneFacts({ chain: key, metric: "acknowledged", milestone, value, asOf: "2026-10-28T05:00:08.000Z" });
  const factsRow = (over: Partial<CatchRow> = {}) => row({ rule: "milestone", facts: JSON.stringify(facts), sourceQuery: MILESTONE_SOURCE_QUERY, ...over });

  it("are the round numbers its row has just passed, and nothing for it while the caller gives no row, as for Arc", () => {
    const found = newMilestones([chain("robinhood", { reviewed: 51, acknowledged: 3 }), extra(key, { acknowledged: value })], []);
    expect(found.map(item => [item.chain, item.metric, item.milestone, item.value])).toEqual([["robinhood", "reviewed", 50, 51], [key, "acknowledged", milestone, value]]);
    expect(found[1]!.asOf).toBe("2026-10-20T16:45:00.000Z");
    // The server gives a row only while the chain's switch is on, so with none there is nothing to say about the chain.
    expect(newMilestones([chain("robinhood", { reviewed: 51, acknowledged: 3 })], []).some(item => item.chain === key)).toBe(false);
    // A count that is not measured, a chain that is not indexed and a count that passed the round number a while ago are not news.
    expect(newMilestones([extra(key, { indexed: false, acknowledged: value })], [])).toEqual([]);
    expect(newMilestones([extra(key, { acknowledged: null, reviewed: null })], [])).toEqual([]);
    expect(newMilestones([extra(key, { acknowledged: milestone - 4 })], [])).toEqual([]);
  });

  it("are not said twice, the next one is, and another chain's does not count", () => {
    const said = past("2026-10-21", "milestone", facts);
    expect(newMilestones([extra(key, { acknowledged: value })], [said])).toEqual([]);
    expect(newMilestones([extra(key, { acknowledged: milestone * 2 + 10 })], [said]).map(item => item.milestone)).toEqual([milestone * 2]);
    const elsewhere = past("2026-10-21", "milestone", milestoneFacts({ chain: key === "base" ? "ethereum" : "base", metric: "acknowledged", milestone, value }));
    expect(newMilestones([extra(key, { acknowledged: value })], [elsewhere]).map(item => item.milestone)).toEqual([milestone]);
  });

  it("come in the order the chains are listed, the original three first and Ethereum, Base and Arc after them", () => {
    const found = newMilestones([extra("arc", { acknowledged: 252 }), extra("base", { acknowledged: 2_520 }), extra("ethereum", { acknowledged: 5_040 }), chain("solana", { reviewed: 51, acknowledged: 3 })], []);
    expect(found.map(item => item.chain)).toEqual(["solana", "ethereum", "base", "arc"]);
  });

  it("are a candidate with the read it came from, ahead of any fleet", () => {
    const [first, second] = candidateCatches({ date: "2026-10-28", wallets: [wallet("0xbig", 5_000)], chains: [extra(key, { acknowledged: value })], past: [] });
    expect(first).toMatchObject({ rule: "milestone", sourceQuery: MILESTONE_SOURCE_QUERY, facts: { chain: key, metric: "acknowledged", milestone, value } });
    expect(second).toMatchObject({ rule: "fleet" });
  });

  it(`are said in ${label}'s own name from the stored facts, with the read's time`, () => {
    expect(headlineOf("milestone", facts)).toBe(`${label} has passed ${milestone.toLocaleString("en-US")} acknowledged entries.`);
    expect(detailOf("milestone", facts)).toBe(`The count is ${value.toLocaleString("en-US")} under the public rules.`);
    expect(howWeKnowOf("milestone", facts, "2026-10-28", MILESTONE_SOURCE_QUERY)).toContain("Last successful read of this chain: 2026-10-28T05:00:08.000Z.");
    expect(parseFacts("milestone", JSON.stringify(facts))).toEqual(facts);
  });

  it("are shown only while the chain's own switch is on in the list given, and no other chain's switch shows them", () => {
    expect(viewOf(factsRow(), feature)!.headline).toBe(`${label} has passed ${milestone.toLocaleString("en-US")} acknowledged entries.`);
    expect(viewOf(factsRow(), ` Claims , ${feature.toUpperCase()} `)).not.toBeNull();
    for (const features of [undefined, "", "claims", others, `${feature}x`]) expect(viewOf(factsRow(), features), String(features)).toBeNull();
    expect(viewOf(factsRow())).toBeNull();
  });
});
