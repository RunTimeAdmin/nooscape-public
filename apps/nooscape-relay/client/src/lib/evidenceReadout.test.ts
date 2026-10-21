import { describe, expect, it } from "vitest";
import { countByEvidenceGroup, evidenceDiffers, evidenceGroup, evidenceRank, evidenceReadout, evidenceSummary, PUBLISHER_STATES, toPublisherState } from "./evidenceReadout";

const observed = (proof: string, publisher = "unverified") => ({ proof, publisherValidation: { status: publisher } });

describe("the publisher state of a record the router sends", () => {
  it("keeps each state the page knows", () => {
    for (const state of PUBLISHER_STATES) expect(toPublisherState(state)).toBe(state);
  });

  it("shows any other state as unverified, never as a stronger one", () => {
    for (const odd of ["suspended", "", "ALLOWLISTED", " allowlisted", "allowlisted "]) expect(toPublisherState(odd), JSON.stringify(odd)).toBe("unverified");
  });
});

describe("the groups the field's filter sorts records into", () => {
  it("sorts a record by the strongest proof it carries now", () => {
    expect(evidenceGroup(observed("TIER_4 · 1 source", "allowlisted"))).toBe("owner");
    expect(evidenceGroup(observed("TIER_3 · 2 source"))).toBe("website");
    expect(evidenceGroup(observed("TIER_2 · 1 source"))).toBe("none");
    expect(evidenceGroup(observed("no tier here"))).toBe("none");
  });

  it("gives a lapsed key no credit, and still sees a domain check that holds beside it", () => {
    for (const lapsed of ["expired", "revoked"]) {
      expect(evidenceGroup(observed("TIER_2 · 1 source", lapsed))).toBe("none");
      expect(evidenceGroup(observed("TIER_3 · 1 source", lapsed))).toBe("website");
    }
  });

  it("counts every record once, so the three counts add up to the total", () => {
    const records = [
      observed("TIER_4", "allowlisted"),
      observed("TIER_3"),
      observed("TIER_3", "revoked"),
      observed("TIER_2"),
      observed("TIER_2", "expired"),
      observed("something else", "unknown-state"),
    ];
    const counts = countByEvidenceGroup(records);
    expect(counts).toEqual({ owner: 1, website: 2, none: 3 });
    expect(counts.owner + counts.website + counts.none).toBe(records.length);
    expect(countByEvidenceGroup([])).toEqual({ owner: 0, website: 0, none: 0 });
  });
});

describe("the evidence readout", () => {
  it("names the tier and its sentence for a record", () => {
    const readout = evidenceReadout(observed("TIER_3 · 2 source"));
    expect(readout).toMatchObject({ kind: "observed", tierLabel: "Tier 3 · Domain-control verified", publisherLabel: "Publisher: unverified" });
    expect(readout.tierSentence).toContain("operator proved control");
  });

  it("states that a record without a tier has nothing verified, instead of inventing one", () => {
    const readout = evidenceReadout(observed("no tier here"));
    expect(readout).toMatchObject({ kind: "observed", tierLabel: "No evidence tier recorded" });
    expect(readout.tierSentence).toContain("nothing about it is verified");
  });

  it("explains each publisher state from the shared sentences, and falls back for an unknown one", () => {
    expect(evidenceReadout(observed("TIER_4", "allowlisted"))).toMatchObject({ publisherLabel: "Publisher: allowlisted", publisherSentence: expect.stringContaining("active allowlisted key") });
    expect(evidenceReadout(observed("TIER_2", "something-new"))).toMatchObject({ publisherSentence: expect.stringContaining("No publisher identity verified") });
  });

  it("never produces a number out of 100", () => {
    for (const agent of [observed("TIER_2"), observed("TIER_4", "allowlisted"), observed("none")]) {
      expect(JSON.stringify(evidenceReadout(agent))).not.toMatch(/\d+\s*\/\s*100/);
      expect(evidenceSummary(agent)).not.toMatch(/\d{2,}/);
    }
  });
});

describe("the short summary", () => {
  it("is the tier number or No tier", () => {
    expect(evidenceSummary(observed("TIER_2 · 1 source"))).toBe("Tier 2");
    expect(evidenceSummary(observed("TIER_4"))).toBe("Tier 4");
    expect(evidenceSummary(observed("nothing"))).toBe("No tier");
  });
});

describe("sorting by evidence", () => {
  it("puts higher tiers first", () => {
    const records = [observed("TIER_2"), observed("TIER_4", "allowlisted"), observed("TIER_3"), observed("nothing")];
    const sorted = [...records].sort((left, right) => evidenceRank(right) - evidenceRank(left));
    expect(sorted.map(evidenceSummary)).toEqual(["Tier 4", "Tier 3", "Tier 2", "No tier"]);
  });

  it("ranks a record with no tier below one with a tier, whatever its publisher says", () => {
    expect(evidenceRank(observed("nothing", "allowlisted"))).toBeLessThan(evidenceRank(observed("TIER_2")));
    expect(evidenceRank(observed("TIER_2"))).toBeLessThan(evidenceRank(observed("TIER_3")));
    expect(evidenceRank(observed("TIER_3"))).toBeLessThan(evidenceRank(observed("TIER_4")));
  });
});

describe("comparing two records", () => {
  it("reports a difference in tier or publisher state, and not otherwise", () => {
    expect(evidenceDiffers(observed("TIER_2"), observed("TIER_3"))).toBe(true);
    expect(evidenceDiffers(observed("TIER_2"), observed("TIER_2", "allowlisted"))).toBe(true);
    expect(evidenceDiffers(observed("TIER_2 · 1 source"), observed("TIER_2 · 5 source"))).toBe(false);
  });
});
