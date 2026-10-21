/**
 * Every figure on the BNB Chain rating census (/field/bnb-ratings-2026-10-16), in one place, each with where it comes
 * from. The page reads only this file, and client/src/pages/bnbRatingsReport.test.ts fails if a number on the page is not
 * one of these, or if one of these does not match the document or the code it names.
 *
 * The read is docs/bsc-rater-credibility-2026-10-16.md. A figure marked ADDENDUM is listed in the addendum at the end of
 * that document (the finalized block and the counts the tables do not give). A figure marked RULES is one of the bars in
 * server/bscRaters.ts, which the test compares with the code. Everything else is in the document's own tables.
 */
export const RATERS_DOC = "docs/bsc-rater-credibility-2026-10-16.md";
export const ADDENDUM = "the addendum of docs/bsc-rater-credibility-2026-10-16.md";
export const RULES = "server/bscRaters.ts";

export type FigureSource = typeof RATERS_DOC | typeof ADDENDUM | typeof RULES;
export type Figure = { value: number; source: FigureSource };

const doc = (value: number): Figure => ({ value, source: RATERS_DOC });
const addendum = (value: number): Figure => ({ value, source: ADDENDUM });
const rule = (value: number): Figure => ({ value, source: RULES });

export const BNB_RATINGS_REPORT = {
  /** The day the ledger was read, and the finalized block the read stopped at. */
  date: "2026-10-16",
  finalizedBlock: addendum(128_045_092),

  /** What the ledger holds. Events are ratings sent plus revocations; a revocation removes one rating. */
  events: doc(29_995),
  ratingsSent: doc(29_994),
  revocations: doc(1),
  ratingsStand: doc(29_993),
  senders: doc(130),
  raters: doc(129),
  agentsRated: doc(4_467),

  /** Finding 1: the concentrated wallets. */
  concentratedWallets: doc(36),
  concentratedRatings: doc(29_551),
  concentratedAgentsFewest: doc(34),
  concentratedAgentsMost: doc(1_800),
  nextBusiestAgents: doc(16),

  /** Finding 2: the one value. */
  ratedValue: doc(70),
  ratedValuePercent: doc(53),
  ratedValueRatings: addendum(16_028),
  ratedValueFromConcentrated: addendum(16_020),

  /** Finding 3: ratings and registrations. */
  selfRatings: doc(0),
  sendersAlsoRegistered: doc(22),

  /** Finding 4: where the ratings went. */
  largestOwnerPercent: doc(43),

  /** Agents by who rated them. */
  threeOrMoreWallets: doc(331),
  threeOrMoreOutsideConcentrated: doc(9),
  afterEveryRule: doc(9),
  registeredByFewerThanFleetWallets: doc(60),
  sharedSetAgents: addendum(4),
  sharedSetWallets: addendum(6),
  groupsOfRaters: addendum(6),

  /** The bars the wallets are set aside by, which the test holds to the constants in server/bscRaters.ts. */
  rules: {
    concentratedMinAgents: rule(20),
    uniformMinRatings: rule(5),
    uniformMinSharePercent: rule(90),
    fleetWalletMin: rule(50),
    minWallets: rule(3),
  },
} as const;

export type BnbRatingsReport = typeof BNB_RATINGS_REPORT;
