/**
 * What a BNB entry's page says about whether Nooscape has read its registration, in the words the operator allowed on 2026-10-18
 * (docs/approvals/2026-10-18-bnb-checked-unproven.md). Pure, so the words can be tested without a browser: the page passes in the
 * date already formatted for the viewer.
 *
 * "Checked" means one thing: Nooscape read the entry's registration, from the link itself or from the file the link names, and the
 * date of that read is on record. It is not a check of the agent's own address, which Nooscape does not ask for a BNB entry, and the
 * line says so. "Unproven" says what the read does not show. The line is on every BNB entry, in one of two forms, so it never works
 * as a badge by omission, and it carries no colour and no count. Nothing from the file is shown, and the entry stays acknowledged,
 * never reviewed, with no tier.
 */

/** What the server answers for a BNB entry: a read with its date, or no read. */
export type RegistrationRead = { checked: true; readAt: Date | string } | { checked: false; readAt: null };

type RegistrationReadLine = { title: string; body: string };

/** What every line says about the entry's place, so a reader never takes a read for a review. */
export const NOT_REVIEWED_SENTENCE = "This entry is not reviewed and has no tier.";
/** What every line says about the agent's own address. Held to the code: no BNB check of that kind runs (CHECKABLE_SOURCE_PROTOCOLS in server/agentChecks.ts). */
export const ADDRESS_NOT_ASKED_SENTENCE = "Nooscape has not asked this agent's own address whether it answers.";

export const CHECKED_TITLE = "Checked, unproven";
export const NOT_CHECKED_TITLE = "Not checked";

/** The line for one entry. `when` is the date of the read as the page formats it; it is not used for an entry that was not checked. */
export function registrationReadLine(read: RegistrationRead, when: string): RegistrationReadLine {
  if (read.checked) {
    return {
      title: CHECKED_TITLE,
      body: `Nooscape read this entry's registration on ${when}. Nothing in that read proves the agent works or that its registrant controls it. ${ADDRESS_NOT_ASKED_SENTENCE} ${NOT_REVIEWED_SENTENCE}`,
    };
  }
  return {
    title: NOT_CHECKED_TITLE,
    body: `Nooscape has not read this entry's registration. That says nothing about the entry. ${ADDRESS_NOT_ASKED_SENTENCE} ${NOT_REVIEWED_SENTENCE}`,
  };
}
