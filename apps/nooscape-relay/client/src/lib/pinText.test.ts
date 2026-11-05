import { describe, expect, it } from "vitest";
import { PIN_TITLE, pinSentence } from "./pinText";

describe("pinSentence", () => {
  it("says who decided, on what day, and what a pin does", () => {
    const sentence = pinSentence("11/5/2026, 9:00:00 AM");
    expect(PIN_TITLE).toBe("Listed by the operator");
    expect(sentence).toContain("The operator pinned this registration on 11/5/2026, 9:00:00 AM.");
    expect(sentence).toContain("whatever the published listing rules say about its link, host, wallet or name");
    expect(sentence).toContain("until the operator removes it");
    expect(sentence).toContain("It is the operator's decision and not the rules'.");
  });

  it("claims nothing about the agent: no word of trust, score, safety or review", () => {
    const sentence = `${PIN_TITLE} ${pinSentence("today")}`;
    expect(sentence).not.toMatch(/trust|score|safe|verified|reviewed|endorse|approved|quality|good|bad/i);
  });

  it("holds no long dash", () => {
    expect(`${PIN_TITLE}${pinSentence("today")}`).not.toMatch(/[\u2013\u2014]/);
  });
});
