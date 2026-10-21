import { describe, expect, it } from "vitest";
import { ADDRESS_NOT_ASKED_SENTENCE } from "../client/src/lib/registrationReadText";
import { CHECKABLE_SOURCE_PROTOCOLS } from "./agentChecks";
import { BSC_NOT_CHECKED, registrationReadOf } from "./bscRegistrationRead";
import { FETCHED, LINK_NOT_READ, NOT_FETCHABLE, UNREADABLE } from "./bscRegistrationFilesCore";

/**
 * The rule behind the "Checked, unproven" line on a BNB entry (docs/approvals/2026-10-18-bnb-checked-unproven.md): checked only when
 * the entry's evidence row records a read of the link the entry carries now. The database read and the shape of the answer are in
 * bscRegistrationRead.integration.test.ts; the words are in client/src/lib/registrationReadText.test.ts.
 */
const HASH = "a".repeat(64);
const READ_AT = new Date("2026-10-16T12:00:00Z");
const evidence = (readStatus: string, overrides: Partial<{ readAt: Date; profileUriHash: string }> = {}) => ({ readStatus, readAt: READ_AT, profileUriHash: HASH, ...overrides });

describe("what counts as a read of a BNB entry's registration", () => {
  it("is a registration decoded from the link itself or read from the file the link names, with the date it was read", () => {
    expect(registrationReadOf(evidence("inline"), HASH)).toEqual({ checked: true, readAt: READ_AT });
    expect(registrationReadOf(evidence(FETCHED), HASH)).toEqual({ checked: true, readAt: READ_AT });
  });

  it("is not a link not read yet, a try that got no file, a file that is not a registration, a link the step does not read or a registration that does not parse", () => {
    for (const status of [LINK_NOT_READ, "link_failed_1", "link_failed_4", "link_unparsed_1", NOT_FETCHABLE, UNREADABLE, "", "something_new"]) {
      expect(registrationReadOf(evidence(status), HASH), status).toBe(BSC_NOT_CHECKED);
    }
  });

  it("is not a read of an older link: the evidence has to come from the link the entry carries now", () => {
    expect(registrationReadOf(evidence("inline", { profileUriHash: "b".repeat(64) }), HASH)).toBe(BSC_NOT_CHECKED);
    expect(registrationReadOf(evidence("inline"), null)).toBe(BSC_NOT_CHECKED);
  });

  it("is not there when the entry has no evidence row at all", () => {
    expect(registrationReadOf(null, HASH)).toBe(BSC_NOT_CHECKED);
    expect(registrationReadOf(undefined, HASH)).toBe(BSC_NOT_CHECKED);
    expect(BSC_NOT_CHECKED).toEqual({ checked: false, readAt: null });
  });
});

describe("what the line says about the agent's own address, held to the code", () => {
  it("says it has not been asked, which is true while no BNB check of that kind runs", () => {
    expect(ADDRESS_NOT_ASKED_SENTENCE).toBe("Nooscape has not asked this agent's own address whether it answers.");
    // The only protocol whose endpoints are checked is A2A. Adding the BNB Chain registry here has to change the line first.
    expect([...CHECKABLE_SOURCE_PROTOCOLS]).toEqual(["a2a"]);
    expect([...CHECKABLE_SOURCE_PROTOCOLS] as string[]).not.toContain("erc8004_bsc");
  });
});
