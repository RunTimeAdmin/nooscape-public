import { describe, expect, it } from "vitest";
import { FLEET_MIN } from "@shared/noosphere";
import {
  CONCENTRATED_MIN_AGENTS,
  classifyRater,
  linkOf,
  liveFeedback,
  MIN_INDEPENDENT_RATERS,
  OWNER_FLEET_MIN,
  rateAgents,
  raterReport,
  raterStats,
  UNIFORM_MIN_EVENTS,
  UNIFORM_MIN_SHARE,
  type AgentFacts,
  type FeedbackEvent,
  type RegistryFacts,
} from "./bscRaters";

/** The discount rules of the BNB rater check, on small examples. The chain and database parts are in bscRatersRun.integration.test.ts. */
const W = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
let counter = 0;
const rating = (agentId: number, client: string, value = "85", overrides: Partial<FeedbackEvent> = {}): FeedbackEvent => {
  counter += 1;
  return { kind: "feedback", agentId, client, feedbackIndex: counter, valueRaw: value, valueDecimals: 0, blockNumber: 1_000 + counter, logIndex: 0, ...overrides };
};
const facts = (over: Partial<RegistryFacts> = {}): RegistryFacts => ({ agents: new Map(), registrations: new Map(), registeredLinks: new Map(), ...over });
const agent = (registrant: string | null, host: string | null = null, linkHash: string | null = null): AgentFacts => ({ registrant, host, linkHash });

describe("the bars", () => {
  it("are the measured ones", () => {
    expect(CONCENTRATED_MIN_AGENTS).toBe(20);
    expect(UNIFORM_MIN_EVENTS).toBe(5);
    expect(UNIFORM_MIN_SHARE).toBe(0.9);
    expect(MIN_INDEPENDENT_RATERS).toBe(3);
    expect(OWNER_FLEET_MIN).toBe(FLEET_MIN);
  });
});

describe("which ratings stand", () => {
  it("removes the rating a revocation names by agent, client and index, and only that one", () => {
    const a = rating(1, W(1), "70", { feedbackIndex: 1 });
    const b = rating(1, W(1), "70", { feedbackIndex: 2 });
    const c = rating(1, W(2), "70", { feedbackIndex: 1 });
    const revoke: FeedbackEvent = { kind: "revoked", agentId: 1, client: W(1), feedbackIndex: 1, valueRaw: null, valueDecimals: null, blockNumber: 5, logIndex: 0 };
    expect(liveFeedback([a, b, c, revoke])).toEqual([b, c]);
  });

  it("keeps a rating whose revocation names another agent, and ignores a revocation that names nothing", () => {
    const a = rating(1, W(1), "70", { feedbackIndex: 1 });
    const elsewhere: FeedbackEvent = { kind: "revoked", agentId: 2, client: W(1), feedbackIndex: 1, valueRaw: null, valueDecimals: null, blockNumber: 5, logIndex: 0 };
    const unnamed: FeedbackEvent = { ...elsewhere, agentId: 1, feedbackIndex: null };
    expect(liveFeedback([a, elsewhere, unnamed])).toEqual([a]);
  });
});

describe("a concentrated rater", () => {
  const ratesAgents = (count: number) => Array.from({ length: count }, (_, n) => rating(1_000 + n, W(1), `${60 + (n % 30)}`));

  it("is a wallet that rated twenty distinct agents or more, and not one that rated nineteen", () => {
    expect(classifyRater(raterStats(ratesAgents(CONCENTRATED_MIN_AGENTS - 1)).get(W(1))!)).toBeNull();
    expect(classifyRater(raterStats(ratesAgents(CONCENTRATED_MIN_AGENTS)).get(W(1))!)).toBe("concentrated");
  });

  it("counts distinct agents, not ratings: a hundred ratings of three agents is not concentrated", () => {
    const events = Array.from({ length: 100 }, (_, n) => rating(1 + (n % 3), W(1), `${50 + (n % 40)}`));
    expect(raterStats(events).get(W(1))).toMatchObject({ events: 100, agents: 3 });
    expect(classifyRater(raterStats(events).get(W(1))!)).toBeNull();
  });

  it("outranks a scripted batch, so a wallet is counted once", () => {
    const events = Array.from({ length: 30 }, (_, n) => rating(n, W(1), "70"));
    expect(classifyRater(raterStats(events).get(W(1))!)).toBe("concentrated");
  });
});

describe("a scripted batch", () => {
  const batch = (count: number, same: number) => Array.from({ length: count }, (_, n) => rating(n % 4, W(2), n < same ? "70" : `${10 + n}`));

  it("is five ratings or more, nine in ten of them one identical value", () => {
    expect(classifyRater(raterStats(batch(10, 9)).get(W(2))!)).toBe("uniform");
    expect(classifyRater(raterStats(batch(10, 8)).get(W(2))!)).toBeNull();
    expect(classifyRater(raterStats(batch(5, 5)).get(W(2))!)).toBe("uniform");
  });

  it("is not four ratings of one value: a few identical ratings are not a batch", () => {
    expect(classifyRater(raterStats(batch(4, 4)).get(W(2))!)).toBeNull();
  });

  it("takes the value and its decimals together, so 70 and 7.0 are different values", () => {
    const events = [...Array.from({ length: 5 }, (_, n) => rating(n, W(2), "70", { valueDecimals: 0 })), ...Array.from({ length: 5 }, (_, n) => rating(n + 5, W(2), "70", { valueDecimals: 1 }))];
    expect(raterStats(events).get(W(2))).toMatchObject({ topValueShare: 0.5 });
    expect(classifyRater(raterStats(events).get(W(2))!)).toBeNull();
  });

  it("is not tied to the value 70: any identical value is a batch", () => {
    const events = Array.from({ length: 6 }, (_, n) => rating(n, W(3), "100"));
    expect(classifyRater(raterStats(events).get(W(3))!)).toBe("uniform");
  });
});

describe("a rater tied to the agent's owner or fleet", () => {
  const registrations = (entries: Array<[string, number]>) => new Map(entries);

  it("is the owner's own wallet", () => {
    expect(linkOf(W(5), agent(W(5)), facts())).toBe("owner");
    expect(linkOf(W(6), agent(W(5)), facts())).toBeNull();
  });

  it("is a fleet wallet, at the fleet minimum and not below it", () => {
    expect(linkOf(W(7), agent(W(5)), facts({ registrations: registrations([[W(7), FLEET_MIN]]) }))).toBe("fleet_wallet");
    expect(linkOf(W(7), agent(W(5)), facts({ registrations: registrations([[W(7), FLEET_MIN - 1]]) }))).toBeNull();
  });

  it("is a wallet that registered an agent with the same link or the same host", () => {
    const links = new Map([[W(8), { hosts: new Set(["shop.example.io"]), hashes: new Set(["hash-a"]) }]]);
    expect(linkOf(W(8), agent(W(5), "shop.example.io"), facts({ registeredLinks: links }))).toBe("same_link");
    expect(linkOf(W(8), agent(W(5), "other.example.io", "hash-a"), facts({ registeredLinks: links }))).toBe("same_link");
    expect(linkOf(W(8), agent(W(5), "other.example.io", "hash-b"), facts({ registeredLinks: links }))).toBeNull();
  });

  it("is not tied by two links that are both missing: no host is not a shared host", () => {
    const links = new Map([[W(8), { hosts: new Set<string>(), hashes: new Set<string>() }]]);
    expect(linkOf(W(8), agent(W(5), null, null), facts({ registeredLinks: links }))).toBeNull();
  });

  it("is not tied when the registry does not hold the agent, apart from a fleet wallet", () => {
    expect(linkOf(W(9), undefined, facts())).toBeNull();
    expect(linkOf(W(9), undefined, facts({ registrations: registrations([[W(9), 500]]) }))).toBe("fleet_wallet");
  });
});

describe("the result for an agent", () => {
  const raters = (agentId: number, clients: string[]) => clients.map(client => rating(agentId, client));

  it("counts three independent raters as a qualifying agent, and two as not", () => {
    const three = rateAgents(raters(1, [W(1), W(2), W(3)]), facts()).get(1)!;
    expect(three).toMatchObject({ rawRaters: 3, independentRaters: 3, concentratedRaters: 0, uniformRaters: 0, linkedRaters: 0, qualifies: true });
    expect(rateAgents(raters(1, [W(1), W(2)]), facts()).get(1)!.qualifies).toBe(false);
  });

  it("counts a rater once however many times it rated, and weights only the independent raters' ratings", () => {
    const events = [rating(1, W(1)), rating(1, W(1)), rating(1, W(1)), rating(1, W(2)), rating(1, W(3))];
    expect(rateAgents(events, facts()).get(1)).toMatchObject({ rawEvents: 5, rawRaters: 3, weightedEvents: 5 });
    const owned = rateAgents(events, facts({ agents: new Map([[1, agent(W(1))]]) })).get(1)!;
    expect(owned).toMatchObject({ rawEvents: 5, rawRaters: 3, linkedRaters: 1, independentRaters: 2, weightedEvents: 2, qualifies: false });
  });

  it("sets aside the concentrated raters first, then the scripted batches, then the tied ones, and the four counts add up to the raters", () => {
    const concentrated = Array.from({ length: CONCENTRATED_MIN_AGENTS }, (_, n) => rating(500 + n, W(10), `${40 + n}`));
    const scripted = Array.from({ length: 6 }, (_, n) => rating(600 + n, W(11), "70"));
    const onAgent = [rating(1, W(10)), rating(1, W(11), "70"), rating(1, W(12)), rating(1, W(13)), rating(1, W(14))];
    const result = rateAgents([...concentrated, ...scripted, ...onAgent], facts({ agents: new Map([[1, agent(W(12))]]) })).get(1)!;
    expect(result).toMatchObject({ rawRaters: 5, concentratedRaters: 1, uniformRaters: 1, linkedRaters: 1, independentRaters: 2, qualifies: false });
    expect(result.concentratedRaters + result.uniformRaters + result.linkedRaters + result.independentRaters).toBe(result.rawRaters);
  });

  it("puts an agent in a fleet when its owner is a fleet wallet, whatever its raters say", () => {
    const events = raters(1, [W(1), W(2), W(3), W(4), W(5)]);
    const owned = rateAgents(events, facts({ agents: new Map([[1, agent(W(99))]]), registrations: new Map([[W(99), FLEET_MIN]]) })).get(1)!;
    expect(owned).toMatchObject({ independentRaters: 5, ownerRegistrations: FLEET_MIN, ownerFleet: true, qualifies: false });
    const small = rateAgents(events, facts({ agents: new Map([[1, agent(W(99))]]), registrations: new Map([[W(99), FLEET_MIN - 1]]) })).get(1)!;
    expect(small).toMatchObject({ ownerFleet: false, qualifies: true });
  });

  it("does not rate an agent that has no rating, and does not depend on the order the ratings arrive in", () => {
    const events = [...raters(1, [W(1), W(2), W(3)]), ...raters(2, [W(1)])];
    const forward = rateAgents(events, facts());
    const backward = rateAgents([...events].reverse(), facts());
    expect(Array.from(forward.keys()).sort()).toEqual([1, 2]);
    expect(rateAgents([], facts()).size).toBe(0);
    expect(backward.get(1)).toEqual(forward.get(1));
    expect(backward.get(2)).toEqual(forward.get(2));
  });

  it("an agent the registry rows do not hold is rated on its raters alone", () => {
    expect(rateAgents(raters(77, [W(1), W(2), W(3)]), facts()).get(77)).toMatchObject({ ownerRegistrations: 0, ownerFleet: false, qualifies: true });
  });
});

describe("a registry shaped like the measured one", () => {
  // 36 concentrated wallets rate 60 agents each, the same 60, all with the value 70. Three agents are also rated by three ordinary wallets each; one of those is the owner.
  const concentratedWallets = Array.from({ length: 36 }, (_, n) => W(1_000 + n));
  const heavy = concentratedWallets.flatMap(client => Array.from({ length: 60 }, (_, n) => rating(n, client, "70")));
  const ordinary = [
    ...[W(1), W(2), W(3)].map(client => rating(1, client)),
    ...[W(4), W(5), W(6)].map(client => rating(2, client)),
    ...[W(7), W(8), W(9)].map(client => rating(3, client)),
  ];
  const owners = new Map<number, AgentFacts>([[3, agent(W(9))]]);

  it("leaves the agents with three independent raters, and none of the ones only the concentrated wallets rated", () => {
    const events = [...heavy, ...ordinary];
    const stats = raterStats(events);
    const classes = new Map(Array.from(stats, ([client, entry]) => [client, classifyRater(entry)] as const));
    const results = rateAgents(events, facts({ agents: owners }), classes);
    const report = raterReport(events, stats, classes, results);
    expect(report).toMatchObject({ ratings: 36 * 60 + 9, raters: 36 + 9, agentsRated: 60, concentratedRaters: 36, concentratedEvents: 36 * 60 });
    // Every one of the sixty agents has 36 or more raters; only the three the ordinary wallets rated have anything left, and one of those three is rated by its own owner.
    expect(report.raw).toBe(60);
    expect(report.afterConcentrated).toBe(3);
    expect(report.afterLinked).toBe(2);
    expect(report.qualifying).toBe(2);
    expect(results.get(0)).toMatchObject({ rawRaters: 36, concentratedRaters: 36, independentRaters: 0, qualifies: false });
    expect(results.get(3)).toMatchObject({ rawRaters: 39, concentratedRaters: 36, linkedRaters: 1, independentRaters: 2, qualifies: false });
  });

  it("is the same whether the classes are given or worked out", () => {
    const events = [...heavy, ...ordinary];
    expect(rateAgents(events, facts({ agents: owners }))).toEqual(rateAgents(events, facts({ agents: owners }), new Map(Array.from(raterStats(events), ([client, entry]) => [client, classifyRater(entry)] as const))));
  });
});
