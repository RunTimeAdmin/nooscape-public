import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADDRESS_NOT_ASKED_SENTENCE, CHECKED_TITLE, NOT_CHECKED_TITLE, NOT_REVIEWED_SENTENCE, registrationReadLine } from "./registrationReadText";

/**
 * The words of the "Checked, unproven" line on a BNB entry (docs/approvals/2026-10-18-bnb-checked-unproven.md): one of two forms on
 * every BNB entry, so it is never a badge by omission, saying what was read and when, what the read does not prove, that the
 * agent's own address was not asked, and that the entry is not reviewed and has no tier.
 */
const checked = registrationReadLine({ checked: true, readAt: new Date("2026-10-16T12:00:00Z") }, "Oct 16 at 7:00 AM CT");
const notChecked = registrationReadLine({ checked: false, readAt: null }, "");

describe("the line for an entry whose registration was read", () => {
  it("is titled Checked, unproven, and gives the date of the read", () => {
    expect(checked.title).toBe("Checked, unproven");
    expect(CHECKED_TITLE).toBe("Checked, unproven");
    expect(checked.body).toContain("Nooscape read this entry's registration on Oct 16 at 7:00 AM CT.");
  });

  it("says what the read does not prove, that the address was not asked, and that the entry is not reviewed", () => {
    expect(checked.body).toContain("Nothing in that read proves the agent works or that its registrant controls it.");
    expect(checked.body).toContain(ADDRESS_NOT_ASKED_SENTENCE);
    expect(checked.body).toContain(NOT_REVIEWED_SENTENCE);
    expect(NOT_REVIEWED_SENTENCE).toBe("This entry is not reviewed and has no tier.");
  });
});

describe("the line for an entry whose registration was not read", () => {
  it("is titled Not checked, says nothing was read, and says that is nothing about the entry", () => {
    expect(notChecked.title).toBe("Not checked");
    expect(NOT_CHECKED_TITLE).toBe("Not checked");
    expect(notChecked.body).toContain("Nooscape has not read this entry's registration. That says nothing about the entry.");
    expect(notChecked.body).toContain(ADDRESS_NOT_ASKED_SENTENCE);
    expect(notChecked.body).toContain(NOT_REVIEWED_SENTENCE);
  });

  it("has no date to give", () => {
    expect(notChecked.body).not.toMatch(/\bon [A-Z][a-z]{2} \d/);
  });
});

describe("both forms", () => {
  const everything = [checked.title, checked.body, notChecked.title, notChecked.body].join(" ");

  it("carry no verdict, no grade and no score, and no long dash", () => {
    expect(everything).not.toMatch(/scam|fraud|fake|spam|sybil|malicious|suspicious|junk|trust|score|rank|verified|healthy|live\b|active|failing|good|bad|safe\b/i);
    expect(everything).not.toMatch(/[–—]/);
    expect(everything).not.toMatch(/\d+\s*(%|of|\/)\s*\d/);
  });

  it("each end with the same two sentences, in the same order, so the two forms read alike", () => {
    for (const body of [checked.body, notChecked.body]) expect(body.endsWith(`${ADDRESS_NOT_ASKED_SENTENCE} ${NOT_REVIEWED_SENTENCE}`)).toBe(true);
  });
});

describe("the line on the entry page", () => {
  const page = readFileSync(new URL("../pages/DirectoryAgent.tsx", import.meta.url), "utf8");
  const part = page.slice(page.indexOf("function RegistrationReadPart"), page.indexOf("function Dot"));

  it("is shown only inside an entry's registry section, after its source note, and only when the server answered", () => {
    expect(page).toContain("{entry.registrationRead && <RegistrationReadPart read={entry.registrationRead} />}");
    const section = page.indexOf('<Section id="dossier-registry"');
    expect(section).toBeGreaterThan(-1);
    expect(page.indexOf("<RegistrationReadPart read=")).toBeGreaterThan(page.indexOf("No source note recorded for this entry."));
    expect(page.indexOf("<RegistrationReadPart read=")).toBeLessThan(page.indexOf('<Part label="Why this page is sparse">'));
  });

  it("has no colour, no pill and no count: a heading and a paragraph in the page's own plain style", () => {
    expect(part).toContain('<Part label="Registration read">');
    expect(part).not.toMatch(/style=|Dot|chip|pill|toLocaleString|\.length/);
    expect(part).toContain("registrationReadLine(read, read.checked ? formatWhen(read.readAt) : \"\")");
  });
});
