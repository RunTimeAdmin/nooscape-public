/**
 * The incidents the status page lists, newest first. Each one is a plain account written after it happened, from a record in
 * docs/ (client/src/pages/status.test.ts checks that the record exists). An entry is added when the site was down or a scheduled
 * read stopped for long enough to matter; a reading of "late" on the status page is not an incident until the operator writes it here.
 */
export type Incident = {
  /** The day it began, in UTC. */
  date: string;
  /** When it began and ended, in UTC, in words. */
  window: string;
  title: string;
  /** What a visitor saw, why, what was done, and what is not known. */
  summary: string;
  /** The file in docs/ that holds the full record. */
  record: string;
};

export const INCIDENTS: readonly Incident[] = [
  {
    date: "2026-11-01",
    window: "From 03:00 to 03:17 UTC, about 16 minutes",
    title: "Every page answered with an error",
    summary:
      "The application could not start because the database refused its account: the account had lost its table privileges, and the application stops when it cannot prepare its tables. The operator restored the privileges in the hosting panel and redeployed, and the site answered again at 03:17 UTC. What caused the loss was not confirmed.",
    record: "incident-2026-11-01-outage.md",
  },
  {
    date: "2026-10-14",
    window: "From about 11:45 to 12:45 UTC, about an hour",
    title: "Every page answered with a 503 from the host's content network",
    summary:
      "A hosting plan upgrade broke two things at once: builds failed because a build tool had lost its execute permission, and the database refused the application's login. The operator corrected the database access in the hosting panel, and the site answered again at 12:45 UTC. Scheduled reads stayed off until 14:46 UTC, because the host's cron runner had stripped the quotes from a request body; the job was recreated.",
    record: "incident-2026-10-14-outage.md",
  },
];
