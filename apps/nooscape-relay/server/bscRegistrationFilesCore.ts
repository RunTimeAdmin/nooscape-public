import { RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS } from "./ingestion/registrationFetch";

/**
 * The pure rules of the BNB registration-file step (docs/approvals/2026-10-17-bnb-registration-files.md). The clustering step stores
 * `link_not_read` for a listed entry whose registration is a web or ipfs link; this step reads the file behind such a link and sets
 * the entry's evidence from it. There is no column for the number of tries, so a try that gave no file is counted in the status
 * itself, and `readAt` says when the last one was. Nothing here touches the network or the database.
 */

export const LINK_NOT_READ = "link_not_read";
export const FETCHED = "fetched";
/** The link is not one this step reads: an `http` address, another scheme, an ipfs address with no CID. */
export const NOT_FETCHABLE = "link_not_fetchable";
/** The chain read for this entry failed or did not decode (a token that reverts), as the clustering step records it for an inline link. */
export const UNREADABLE = "unreadable";
const FAILED_PREFIX = "link_failed_";
const UNPARSED_PREFIX = "link_unparsed_";

/** A link that did not answer is tried this many times at most, and a file that is not a registration this many. The Solana name reader's tries. */
export const FILE_FAILED_MAX_TRIES = RESOLUTION_FAILED_MAX_ATTEMPTS;
export const FILE_UNPARSED_MAX_TRIES = RESOLUTION_NO_NAME_MAX_ATTEMPTS;
/** A link is tried again no sooner than this after its last try. */
export const FILE_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const failedStatus = (tries: number) => `${FAILED_PREFIX}${tries}`;
const unparsedStatus = (tries: number) => `${UNPARSED_PREFIX}${tries}`;

/** The number of tries a status records, in the family it belongs to (`link_not_read` is none), or null for a status that is not a link waiting. */
function triesIn(status: string, prefix: string): number | null {
  if (!status.startsWith(prefix)) return null;
  const tries = Number(status.slice(prefix.length));
  return Number.isInteger(tries) && tries > 0 ? tries : null;
}

/** Every status that is due another try once its time has come: never tried, or tried and not yet at its limit. */
export const WAITING_STATUSES: readonly string[] = [
  LINK_NOT_READ,
  ...Array.from({ length: FILE_FAILED_MAX_TRIES - 1 }, (_, index) => failedStatus(index + 1)),
  ...Array.from({ length: FILE_UNPARSED_MAX_TRIES - 1 }, (_, index) => unparsedStatus(index + 1)),
];

/** The status after a try that gave no file (the address did not answer, a rule stopped it, the body was too big). */
export function statusAfterFailedTry(status: string): string {
  return failedStatus((triesIn(status, FAILED_PREFIX) ?? 0) + 1);
}

/** The status after a try that gave a file which is not a registration, or no file (a 404 or 410). */
export function statusAfterUnparsedTry(status: string): string {
  return unparsedStatus((triesIn(status, UNPARSED_PREFIX) ?? 0) + 1);
}

/** True when the status is a link that has used all its tries, and is settled. */
export function isSettledLink(status: string): boolean {
  return (triesIn(status, FAILED_PREFIX) ?? 0) >= FILE_FAILED_MAX_TRIES || (triesIn(status, UNPARSED_PREFIX) ?? 0) >= FILE_UNPARSED_MAX_TRIES || status === NOT_FETCHABLE;
}
