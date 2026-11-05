/**
 * What an entry's page says when the operator pinned its registration (migration 0056; docs/pin-disclosure-2026-11-05.md). Pure, so the
 * words can be tested without a browser: the page passes in the date already formatted for the viewer.
 *
 * A pin is the one place a person's decision, and not a published rule, puts an entry in the listing. So the entry says so, in the same
 * words on every pinned entry, with the date and whatever note the operator wrote. The sentence claims nothing about the agent: it says
 * who decided and what a pin does.
 */
export const PIN_TITLE = "Listed by the operator";

/** The sentence for one pinned entry. `when` is the day the pin was set, as the page formats it. */
export function pinSentence(when: string): string {
  return `The operator pinned this registration on ${when}. A pin keeps a registration listed whatever the published listing rules say about its link, host, wallet or name, until the operator removes it. It is the operator's decision and not the rules'.`;
}
