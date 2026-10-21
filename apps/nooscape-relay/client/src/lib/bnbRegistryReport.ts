/**
 * Every figure on the BNB registry census report (/field/bnb-registry-2026-10-16), in one place, each with where it
 * comes from. The page reads only this file, and client/src/pages/bnbRegistryReport.test.ts fails if a number on the
 * page is not one of these, or if one of these does not match the document it names.
 *
 * The measurement is docs/bsc-b1-measurement-2026-10-16.md. A figure marked RECOMPUTED was not published there: it was
 * worked out again from the saved output of that run (entries.csv and registrations.jsonl in bsc-b1-output) with the
 * junk filter removed, because the report does not use that filter. The old and new values are side by side in the
 * addendum at the end of that document, which the test also reads.
 */
export const B1_DOC = "docs/bsc-b1-measurement-2026-10-16.md";
export const B2_DOC = "docs/bsc-clusters-2026-10-16.md";
export const RECOMPUTED = "recomputed from the saved B1 output, junk filter removed";

export type FigureSource = typeof B1_DOC | typeof B2_DOC | typeof RECOMPUTED;
export type Figure = { value: number; source: FigureSource; note?: string };

const figure = (value: number, source: FigureSource, note?: string): Figure => ({ value, source, ...(note ? { note } : {}) });
const fromB1 = (value: number, note?: string) => figure(value, B1_DOC, note);
const recomputed = (value: number, note: string) => figure(value, RECOMPUTED, note);

const filesRead = fromB1(5_768);
const noHttpsAddress = fromB1(5_099);

export const BNB_REGISTRY_REPORT = {
  /** The day the run was made, and the finalized block the chain scan stopped at (B1, first lines). */
  date: "2026-10-16",
  finalizedBlock: fromB1(128_020_960),
  userAgent: "Nooscape-Checker/1.0",
  /** How many times the run passed over each thing (B1, Method). The registration files were read twice; the figures are from the second pass. */
  passes: { chain: 1, registrationFiles: 2, agentAddresses: 1 },

  registrations: fromB1(375_343, "Replayed from the chain at the finalized block (B1, G0 detail)."),
  listed: fromB1(6_842),
  independent: fromB1(5_912, "Listed entries that are not in a template group. Counts the 144 files that could not be read as independent."),
  filesRead,
  filesUnread: fromB1(144),
  complete: fromB1(665, "A name, a description and at least one https agent address."),

  /** Of the 665 complete entries, what happened to the request for their agent address. The three add up to 665. */
  answered: recomputed(269, "B1 publishes 264 over the 645 complete entries without a junk flag."),
  answeredClean: recomputed(218, "B1 publishes 213 over the 645. The same, with a 2xx or 3xx status from at least one address."),
  notAnswered: recomputed(145, "B1 publishes 143 over the 645. No answer: the name did not resolve, a timeout, a TLS failure or a failed connection."),
  notAsked: recomputed(251, "B1 publishes 238 over the 645, plus the 11 placeholder addresses the junk filter had removed. A rule stopped the request: robots.txt that could not be read or kept the checker out, or a placeholder address."),

  /** The A2A agent cards, among the entries that answered. Not a registry-wide figure. */
  a2aAsked: recomputed(136, "Entries that answered and declare an A2A service, whose card was asked for. B1 publishes 134 over the 264."),
  a2aValid: recomputed(101, "Cards with a name, a description and an address. B1 publishes 100 over the 264."),

  /** Finding 1. */
  noHttpsAddress,
  noHttpsAddressPercent: Math.round((noHttpsAddress.value / filesRead.value) * 100),
  otherFieldAddress: fromB1(320, "Of the 5,099, an https address under a field the standard does not use (url or website). Counted in the 5,099 and not asked."),

  /** Finding 2. */
  templateGroups: fromB1(150),
  templateEntries: fromB1(930),
  /** What the clustering step the worker runs counted on the same registry on the day of the census (it then read only registrations that hold their file inside themselves; since the registration-file step it reads the others too). The map's fleet lights are built from the groups it stores, but they draw only the ten largest of any kind. */
  workerTemplateGroups: figure(141, B2_DOC),
  workerTemplateEntries: figure(908, B2_DOC),

  /** Finding 3, and the note on the independent count. The two host names are not named anywhere in this file or on the page. */
  hostNamesComplete: recomputed(328, "Complete entries that declare an agent address on one of the two host names. B1 publishes 327 of 645."),
  hostNamesIndependents: fromB1(328, "Independent entries that declare an agent address on one of the two host names that no rule groups."),

  /** The caveat about how steady the numbers are (B1, Method). */
  filesFetched: fromB1(367),
  filesChanged: fromB1(33),

  /**
   * Two pairs of numbers that look alike and are not the same thing, so the page cannot be read against the wrong one.
   */
  explanations: {
    hostNames327And328:
      "B1 says 327 of the 645 complete entries without a junk flag sit on the two host names, and 328 independents sit on them. They are the same entries. All 328 independents on those host names are complete, and one of the 328 carries a junk flag. B1's 327 leaves that one out because the 645 excludes flagged entries; with the filter removed the count is 328 of 665. The report uses 328 both for the independents (the note on the independent count) and for the complete entries (finding 3).",
    templateGroupsAndLights:
      "The report counts 150 template groups holding 930 entries because B1 also read the registration files behind web and ipfs links. The clustering step the worker ran on the day of the census (docs/bsc-clusters-2026-10-16.md) read only registrations that hold their file inside themselves, and counted 141 groups holding 908 entries on the same registry. The worker now reads the files behind web and ipfs links too (docs/approvals/2026-10-17-bnb-registration-files.md), so its count moves toward the report's. The 9 more groups and 22 more entries come from entries whose files were read through a link. The home page's fleet lights are built from the groups that step stores, but they draw only the ten largest groups of any kind, so the 141 template groups are not what the map shows: on 2026-10-17 the ten drawn were platform hosts, shared links and wallets.",
    notAskedAndSkipped:
      "B1 counts 238 of the 645 as skipped by a rule. Over the 665 the figure is 251: the same rule stops 240 requests, and 11 more entries have a placeholder address that is never asked.",
  },
} as const;

export type BnbRegistryReport = typeof BNB_REGISTRY_REPORT;
