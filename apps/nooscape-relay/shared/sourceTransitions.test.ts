import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canDecideSource, SOURCE_TRANSITIONS, type SourceDecision, type SourceState } from "./sourceTransitions";

const STATES: SourceState[] = ["review", "active", "paused", "rejected"];
const DECISIONS: SourceDecision[] = ["active", "paused", "rejected"];

describe("the decisions an operator may make about a source", () => {
  it("allows only Approve and Reject in review, Pause when active, Resume when paused, and nothing once rejected", () => {
    const allowed = STATES.flatMap(from => DECISIONS.filter(to => canDecideSource(from, to)).map(to => `${from}>${to}`));
    expect(allowed).toEqual(["review>active", "review>rejected", "active>paused", "paused>active"]);
    expect(SOURCE_TRANSITIONS.rejected).toEqual([]);
  });

  it("is what the console offers: every decision button there is gated on the table", () => {
    const page = readFileSync(new URL("../client/src/pages/SourceOperations.tsx", import.meta.url), "utf8");
    const buttons = [...page.matchAll(/\{([^{}]*?) \? <Button[^>]*onClick=\{\(\) => decideMutation\.mutate\(\{ sourceId: source\.id, decision: "(\w+)"/g)];
    expect(buttons).toHaveLength(4);
    for (const [, condition, decision] of buttons) expect(condition).toContain(`canDecideSource(source.state, "${decision}")`);
  });
});
